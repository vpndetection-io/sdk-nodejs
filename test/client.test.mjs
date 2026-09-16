// The Node-specific API surface, as distinct from the shared conformance
// corpus in conformance.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { VPNDetection, VPNDetectionError, isBogon } from '../dist/index.js';

const data = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8'));

// Answers slowly enough that concurrent calls overlap, and records the peak
// number in flight. Asserting the PEAK is the only way to tell a real limit
// from an option that was accepted and ignored. A batch arrives as one POST per
// chunk, so it is answered from the addresses in the body.
function concurrencyTrackingFetch(delayMs = 20) {
    const state = { inFlight: 0, peak: 0, calls: 0 };
    const fn = async (input, init) => {
        const body = typeof input === 'string' ? (init?.body ?? '') : await input.text();
        state.calls++;
        state.inFlight++;
        state.peak = Math.max(state.peak, state.inFlight);
        await new Promise((r) => setTimeout(r, delayMs));
        state.inFlight--;
        const results = {};
        for (const ip of JSON.parse(body || '{}').ips ?? []) {
            results[ip] = { ip: ip, is_vpn: false };
        }
        return new Response(JSON.stringify({ results: results, errors: {} }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    return { fetch: fn, state: state };
}

// Enough addresses for seven chunks of the batch endpoint's 1000, so a
// concurrency bound has something to bound: one request per chunk, and only the
// chunks overlap.
const addrs = Array.from(
    { length: 6001 },
    (_, i) => `9.${1 + Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`,
);

test('isBogon is on the client and agrees with the standalone export', () => {
    const client = new VPNDetection();
    for (const c of data.isBogon) {
        assert.equal(client.isBogon(c.ip), c.expect, `${c.ip} (${c.why})`);
        assert.equal(client.isBogon(c.ip), isBogon(c.ip), `${c.ip}: client and export disagree`);
    }
});

test('batch concurrency is configurable per call', async () => {
    const t = concurrencyTrackingFetch();
    const client = new VPNDetection({ fetch: t.fetch, cache: false });

    await client.lookupBatch(addrs, { concurrency: 3 });

    assert.equal(t.state.calls, 7, 'one request per chunk of 1000');
    assert.ok(t.state.peak <= 3, `peak in flight was ${t.state.peak}, expected at most 3`);
    assert.ok(t.state.peak > 1, 'requests should still overlap');
});

test('a per-call concurrency overrides the client default', async () => {
    const t = concurrencyTrackingFetch();
    // Instance default of 2, raised to 6 for this one batch.
    const client = new VPNDetection({ fetch: t.fetch, cache: false, concurrency: 2 });

    await client.lookupBatch(addrs, { concurrency: 6 });

    assert.ok(t.state.peak > 2, `override ignored: peak was ${t.state.peak}, expected above 2`);
    assert.ok(t.state.peak <= 6, `peak in flight was ${t.state.peak}, expected at most 6`);
});

test('without an override the client concurrency still applies', async () => {
    const t = concurrencyTrackingFetch();
    const client = new VPNDetection({ fetch: t.fetch, cache: false, concurrency: 2 });

    await client.lookupBatch(addrs);

    assert.ok(t.state.peak <= 2, `peak in flight was ${t.state.peak}, expected at most 2`);
});

test('retries are configurable per call', async () => {
    let calls = 0;
    const fetchFn = async () => {
        calls++;
        return new Response(JSON.stringify({ error: 'lookup failed' }), {
            status: 500, headers: { 'content-type': 'application/json' },
        });
    };
    const client = new VPNDetection({ fetch: fetchFn, cache: false, retries: 0 });

    await assert.rejects(() => client.lookup('9.9.9.9', { retries: 2 }));
    // 1 initial attempt plus 2 retries, rather than the instance's 0.
    assert.equal(calls, 3);
});

// A caller never chunks. 2,500 distinct addresses are three POST /batch requests
// of at most 1000, each address sent once and answered for itself.
test('a batch takes any number of addresses and chunks them itself', async () => {
    const ips = Array.from({ length: 2500 }, (_, i) => `9.1.${Math.floor(i / 256)}.${i % 256}`);
    const posts = [];
    const fetchFn = async (input) => {
        const sent = JSON.parse(await input.text()).ips;
        posts.push({ method: input.method, path: new URL(input.url).pathname, ips: sent });
        const results = Object.fromEntries(sent.map((ip) => [ip, { ip: ip, is_vpn: false }]));
        return new Response(JSON.stringify({ results: results, errors: {} }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    const client = new VPNDetection({ fetch: fetchFn, cache: false });

    const got = await client.lookupBatch(ips);

    assert.equal(posts.length, 3, 'one request per chunk of 1000');
    for (const post of posts) {
        assert.equal(post.method, 'POST');
        assert.equal(post.path, '/batch');
        assert.ok(post.ips.length <= 1000, `a chunk carried ${post.ips.length} addresses`);
    }
    assert.deepEqual(posts.flatMap((p) => p.ips).sort(), [...ips].sort(), 'each address sent exactly once');
    assert.equal(got.size, ips.length);
    for (const ip of ips) {
        assert.equal(got.get(ip).ip, ip, `${ip} should be answered for itself`);
    }
});

// Two ways a response stalls: nothing arrives, or the headers do and the body
// never finishes. The deadline has to bound the whole call, not just the first.
const STALLS = {
    'no response': () => new Promise(() => {}),
    'a body that never ends': async () => new Response(new ReadableStream({ start() {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
    }),
};

// Every call that takes per-call options, each surfacing its failure as a
// rejection. A batch reports a failed chunk as every address's value instead of
// throwing, so that one rethrows what it was given.
const PER_CALL = {
    'lookup': (c, o) => c.lookup('45.83.91.1', o),
    'myIp': (c, o) => c.myIp(o),
    'myEntitlement': (c, o) => c.myEntitlement(o),
    'lookupBatch': async (c, o) => {
        const answers = [...(await c.lookupBatch(['45.83.91.1', '9.9.9.9'], o)).values()];
        assert.ok(answers.every((a) => a instanceof VPNDetectionError), 'the chunk should fail as a whole');
        throw answers[0];
    },
    'database.downloads': (c, o) => c.database.downloads({ limit: 5, ...o }),
};

// Set BELOW the client's, so the only deadline that can fire in time is the
// per-call one, and its message names which one it was.
test('a per-call timeoutMs bounds every call below the client default', async () => {
    for (const [stallName, stall] of Object.entries(STALLS)) {
        for (const [call, invoke] of Object.entries(PER_CALL)) {
            const client = new VPNDetection({ retries: 0, timeoutMs: 10_000, cache: false, fetch: stall });
            const label = `${call}, ${stallName}`;
            const started = Date.now();
            await assert.rejects(() => invoke(client, { timeoutMs: 80 }), (err) => {
                assert.ok(err instanceof VPNDetectionError, `${label}: wrong error type`);
                assert.equal(err.kind, 'network', label);
                assert.equal(err.retryable, true, label);
                assert.match(err.message, /timed out after 80ms/, label);
                return true;
            });
            assert.ok(Date.now() - started < 2000, `${label}: the per-call deadline did not hold`);
        }
    }
});

// Per ATTEMPT, like the client-level one: a retried call gets a fresh budget.
test('a per-call timeoutMs applies to each attempt', async () => {
    let calls = 0;
    const client = new VPNDetection({
        retries: 0,
        timeoutMs: 10_000,
        cache: false,
        fetch: () => {
            calls++;
            return new Promise(() => {});
        },
    });
    await assert.rejects(
        () => client.lookup('45.83.91.1', { retries: 1, timeoutMs: 80 }),
        (err) => err instanceof VPNDetectionError && /timed out after 80ms/.test(err.message),
    );
    assert.equal(calls, 2, 'one attempt plus one retry, each abandoned at its own deadline');
});

// The database responses nest their payload, and a hand-written unwrap shape is
// a claim the compiler cannot check. `checksums` shipped broken in 1.0.x for
// exactly that reason: it read a top-level `sha256` that is not there, and
// returned undefined against a perfectly healthy API.
test('database responses are unwrapped at the right depth', async () => {
    const routes = {
        '/api/v1/database/checksum': {
            id: 'vpn_ip_extended_v1',
            format: 'mmdb',
            checksums: { md5: 'm', sha1: 's1', sha256: 's256', sha512: 's512' },
        },
        '/api/v1/database/list': { databases: [{ id: 'vpn_ip_extended_v1' }] },
        '/api/v1/database/downloads': { downloads: [{ id: 'vpn_ip_extended_v1' }] },
        '/api/v1/database/metadata': { id: 'vpn_ip_extended_v1', columns: [] },
    };
    const fetchFn = async (input) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        return new Response(JSON.stringify(routes[url.pathname]), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    const client = new VPNDetection({ fetch: fetchFn, apiKey: 'k' });

    const sums = await client.database.checksums('vpn_ip_extended_v1', 'mmdb');
    assert.deepEqual(sums, { md5: 'm', sha1: 's1', sha256: 's256', sha512: 's512' });
    assert.equal(sums.sha256, 's256', 'the digest a caller actually wants must not be undefined');

    assert.deepEqual(await client.database.list(), [{ id: 'vpn_ip_extended_v1' }]);
    assert.deepEqual(await client.database.downloads(), [{ id: 'vpn_ip_extended_v1' }]);
    assert.equal((await client.database.metadata('vpn_ip_extended_v1')).id, 'vpn_ip_extended_v1');
});

// The spec documents three credential forms because the API accepts three, and
// the generator will happily apply all of them - putting the key in the query
// string of every request. A query string is the one place a secret must not
// be: access logs, proxy logs and browser history all keep it, and none of
// those are ours. Asserted on what leaves the client, because the request still
// succeeds either way.
test('the key is sent in the Authorization header and nowhere else', async () => {
    let seen = null;
    const fetchFn = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const headers = new Headers(input?.headers ?? init?.headers ?? {});
        seen = {
            query: url.searchParams.get('apikey'),
            authorization: headers.get('authorization'),
            xApiKey: headers.get('x-api-key'),
        };
        return new Response(JSON.stringify({ databases: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    await new VPNDetection({ fetch: fetchFn, apiKey: 'SECRET' }).database.list();

    assert.equal(seen.authorization, 'Bearer SECRET');
    assert.equal(seen.query, null, 'the key must never reach a URL');
    assert.equal(seen.xApiKey, null, 'one credential form, not three');
});

// The API bounds the history at 200 and defaults to 50. An option that is
// accepted and silently dropped passes any test that only reads the result, so
// this asserts the query string that actually left.
test('the downloads limit reaches the wire, and is omitted when not given', async () => {
    const seen = [];
    const fetchFn = async (input) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        seen.push(url.searchParams.get('limit'));
        return new Response(JSON.stringify({ downloads: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    const client = new VPNDetection({ fetch: fetchFn, apiKey: 'k' });

    await client.database.downloads();
    await client.database.downloads({ limit: 200 });

    assert.equal(seen[0], null, 'no limit means no query parameter, so the API default applies');
    assert.equal(seen[1], '200');
});

test('a per-call timeoutMs never reaches the wire', async () => {
    const seen = [];
    const fetchFn = async (input) => {
        seen.push([...new URL(typeof input === 'string' ? input : input.url).searchParams.keys()]);
        return new Response(JSON.stringify({ downloads: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    const client = new VPNDetection({ fetch: fetchFn, apiKey: 'k' });

    await client.database.downloads({ limit: 5, timeoutMs: 5000 });

    assert.deepEqual(seen[0], ['limit']);
});

// A fetch that answers one fixed body and counts calls, for the two endpoints
// that take no argument.
function countingFetch(body) {
    const state = { calls: 0, urls: [] };
    const fn = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        state.calls++;
        state.urls.push(new URL(url).pathname);
        return new Response(JSON.stringify(body), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    return { fetch: fn, state: state };
}

test('myIp asks the server which address you are', async () => {
    const t = countingFetch({ ip: '203.0.113.9', is_vpn: true });
    const client = new VPNDetection({ fetch: t.fetch });
    const result = await client.myIp();
    assert.equal(result.ip, '203.0.113.9');
    assert.equal(result.isVpn, true);
    assert.equal(t.state.urls[0], '/myip');
});

// The cache is keyed by address, and which address this is IS the question, so
// a second call has to ask again.
test('myIp is not cached', async () => {
    const t = countingFetch({ ip: '203.0.113.9', is_vpn: false });
    const client = new VPNDetection({ fetch: t.fetch });
    await client.myIp();
    await client.myIp();
    await client.myIp();
    assert.equal(t.state.calls, 3);
});

test('myEntitlement reports the plan and the usage', async () => {
    const t = countingFetch({
        org_id: '85bb51e4-2eb6-4a31-8e4d-02ba8b98fe61',
        apikey: { id: '0ab424cc-7619-4dad-b027-afacdc2cedb0', expires: null, allowed_cidrs: [] },
        plan: { key: 'max', tier: 'max' },
        usage: {
            requests: 580, quota: 5000000, hard_limit: null,
            window_start: '2026-09-04T07:00:00Z', window_end: '2026-10-04T07:00:00Z',
        },
    });
    const client = new VPNDetection({ fetch: t.fetch, apiKey: 'k' });
    const ent = await client.myEntitlement();
    assert.equal(ent.plan.key, 'max');
    assert.equal(ent.usage.requests, 580);
    // An uncapped plan reports null, which is not zero: zero would read as
    // "stop serving immediately".
    assert.equal(ent.usage.hard_limit, null);
    assert.equal(t.state.urls[0], '/api/v1/entitlement');
});

// Usage is the whole point, so a cached answer is a wrong one within seconds.
test('myEntitlement is not cached', async () => {
    const t = countingFetch({
        org_id: 'f32191d0-ef02-450e-a505-eb5814c35cab',
        apikey: { id: '10c2b437-3aa2-4a63-bd17-8e7c8c7f0def', expires: null, allowed_cidrs: [] },
        plan: { key: 'free', tier: 'free' },
        usage: {
            requests: 1, quota: 2, hard_limit: 2,
            window_start: '2026-09-01T00:00:00Z', window_end: '2026-10-01T00:00:00Z',
        },
    });
    const client = new VPNDetection({ fetch: t.fetch, apiKey: 'k' });
    await client.myEntitlement();
    await client.myEntitlement();
    assert.equal(t.state.calls, 2);
});
