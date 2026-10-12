// What each call does with a 2xx it cannot read as its answer, how a Retry-After
// is read, and what an API key sends. Through 5.5.1 a batch chunk of `{}` threw a
// raw TypeError, `lookup` answered a Result holding nothing for `{}`, `list`
// answered undefined and `metadata` the HTML itself, nothing was retried, `+1`,
// `0x10`, ISO dates and other zones read as throttles, and a blank key went out
// as `Authorization: Bearer`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { VPNDetection } from '../dist/index.js';

const IP = '45.83.91.1';
const OTHER = '9.9.9.9';

function rawClient(reply, options = {}) {
    const calls = [];
    const fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({ url: request.url, auth: request.headers.get('authorization') });
        return reply(request);
    };
    return { calls: calls, client: new VPNDetection({ apiKey: 'test-key', fetch: fetch, retries: 2, cache: false, ...options }) };
}

function body(text, type = 'application/json') {
    return () => new Response(text, { status: 200, headers: { 'content-type': type } });
}

// The body stops part way, as when a proxy drops the connection.
function cutOff() {
    return () => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ip":"45.83.91.1","is_v'));
            controller.error(new TypeError('terminated'));
        },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Each call, a body with its member of the wrong type, and one missing a member it needs.
const CALLS = {
    lookup: [(c) => c.lookup(IP), `{"ip":"${IP}","is_vpn":"no"}`, `{"ip":"${IP}"}`],
    myIp: [(c) => c.myIp(), `{"ip":1,"is_vpn":false}`, '{"is_vpn":false}'],
    myEntitlement: [(c) => c.myEntitlement(), '{"org_id":"o","apikey":"x","plan":{},"usage":{}}', '{"org_id":"o"}'],
    list: [(c) => c.database.list(), '{"databases":"x"}', '{"databases":[{}]}'],
    metadata: [(c) => c.database.metadata('vpn_ip'), '{"id":1,"updated":"","entries":"x","schema":{}}', '{"id":"vpn_ip"}'],
    checksums: [(c) => c.database.checksums('vpn_ip_v1', 'mmdb'), '{"checksums":"x"}', '{"checksums":{}}'],
    downloads: [(c) => c.database.downloads(), '{"downloads":"x"}', '{"downloads":[{}]}'],
};

test('a 2xx a call cannot read is a retried server_error carrying its status', async () => {
    for (const [name, [call, wrongType, noMembers]] of Object.entries(CALLS)) {
        const replies = {
            html: body('<html><body>Bad gateway</body></html>', 'text/html'),
            cut: cutOff(),
            empty: body(''),
            null: body('null'),
            array: body('[]'),
            object: body('{}'),
            wrongType: body(wrongType),
            noMembers: body(noMembers),
        };
        // Concurrently, since each sits out the retries' backoff.
        await Promise.all(Object.entries(replies).map(async ([kind, reply]) => {
            const c = rawClient(reply);
            await assert.rejects(() => call(c.client), (err) => {
                assert.equal(err.kind, 'server_error', `${name} ${kind}: ${err.message}`);
                assert.equal(err.status, 200, `${name} ${kind}`);
                return true;
            });
            assert.equal(c.calls.length, 3, `${name} ${kind} is retried`);
        }));
    }
});

test('a batch chunk it cannot read is retried, and fails every address with the status', async () => {
    const replies = {
        html: body('<html><body>Bad gateway</body></html>', 'text/html'),
        cut: cutOff(),
        empty: body(''),
        null: body('null'),
        array: body('[]'),
        object: body('{}'),
        noErrors: body(`{"results":{"${IP}":{"ip":"${IP}","is_vpn":false}}}`),
        wrongType: body('{"results":[],"errors":{}}'),
    };
    await Promise.all(Object.entries(replies).map(async ([kind, reply]) => {
        const c = rawClient(reply);
        const out = await c.client.lookupBatch([IP, OTHER]);
        for (const ip of [IP, OTHER]) {
            assert.equal(out.get(ip).kind, 'server_error', `${kind} ${ip}: ${out.get(ip).message}`);
            assert.equal(out.get(ip).status, 200, `${kind} ${ip}`);
        }
        assert.equal(c.calls.length, 3, `${kind} is retried`);
    }));
});

test('one batch entry it cannot read is that address error alone', async () => {
    for (const entry of [{}, [], 'x', { ip: OTHER }]) {
        for (const map of ['results', 'errors']) {
            const answer = { results: { [IP]: { ip: IP, is_vpn: true } }, errors: {} };
            answer[map][OTHER] = entry;
            const c = rawClient(body(JSON.stringify(answer)));
            const out = await c.client.lookupBatch([IP, OTHER]);
            assert.equal(out.get(IP).isVpn, true, `${map} ${JSON.stringify(entry)}`);
            assert.equal(out.get(OTHER).kind, "server_error", `${map} ${JSON.stringify(entry)}`);
            assert.equal(out.get(OTHER).status, 200, `${map} ${entry}`);
            assert.equal(c.calls.length, 1, `${map} ${entry} is not retried for one entry`);
        }
    }
});

test('a readable answer still comes back', async () => {
    let c = rawClient(body(`{"ip":"${IP}","is_vpn":true}`));
    assert.equal((await c.client.lookup(IP)).isVpn, true);
    const entitlement = {
        org_id: 'o', apikey: { id: 'k', expires: null, allowed_cidrs: [] }, plan: { key: 'max', tier: 'max' },
        usage: { requests: 1, quota: 10, hard_limit: null, window_start: 's', window_end: 'e' },
    };
    c = rawClient(body(JSON.stringify(entitlement)));
    assert.deepEqual(await c.client.myEntitlement(), entitlement);
    const database = {
        base: 'vpn_ip', name: 'n', summary: 's', license_type: null, starts: null, expires: null, renews_at: null,
        notice_due_at: null, in_term: false, standing: 'available', versions: [{ id: 'vpn_ip_v1', version: 1,
            formats: [{ format: 'mmdb', bytes: null }] }],
    };
    c = rawClient(body(JSON.stringify({ databases: [database] })));
    assert.deepEqual(await c.client.database.list(), [database]);
    c = rawClient(body(`{"results":{"${IP}":{"ip":"${IP}","is_vpn":true}},"errors":{"${OTHER}":{"status":429,"error":"spent"}}}`));
    const out = await c.client.lookupBatch([IP, OTHER]);
    assert.equal(out.get(IP).isVpn, true);
    assert.equal(out.get(OTHER).kind, 'quota_exceeded');
    assert.equal(c.calls.length, 1);
});

// The lists are hand-written, so a member the spec makes required, and never null,
// must not be able to go unchecked: read the generated types and compare.
test('each checked member list is every required member of its generated type', async () => {
    const shapes = await import('../dist/shapes.js');
    const types = readFileSync(new URL('../src/generated/types.gen.ts', import.meta.url), 'utf8');
    const required = (name) => {
        const block = types.split(`export type ${name} = {\n`)[1].split('\n};')[0];
        return [...block.matchAll(/^ {4}([a-z][a-z0-9_]*): (.*)$/gm)]
            .filter((m) => !/\| null;$/.test(m[2])).map((m) => m[1]).sort();
    };
    assert.deepEqual([...shapes.LOOKUP_MEMBERS].sort(), required('LookupResponse'));
    assert.deepEqual([...shapes.BATCH_MEMBERS].sort(), required('BatchLookupResponse'));
    assert.deepEqual([...shapes.BATCH_ERROR_MEMBERS].sort(), required('BatchLookupError'));
    assert.deepEqual([...shapes.ENTITLEMENT_MEMBERS].sort(), required('Entitlement'));
    assert.deepEqual([...shapes.ENTITLEMENT_APIKEY_MEMBERS].sort(), required('EntitlementApikey'));
    assert.deepEqual([...shapes.ENTITLEMENT_PLAN_MEMBERS].sort(), required('EntitlementPlan'));
    assert.deepEqual([...shapes.ENTITLEMENT_USAGE_MEMBERS].sort(), required('EntitlementUsage'));
    assert.deepEqual([...shapes.DATABASE_MEMBERS].sort(), required('Database'));
    assert.deepEqual([...shapes.DATABASE_VERSION_MEMBERS].sort(), required('DatabaseVersion'));
    assert.deepEqual([...shapes.DATABASE_FORMAT_SIZE_MEMBERS].sort(), required('DatabaseFormatSize'));
    assert.deepEqual([...shapes.DATABASE_METADATA_MEMBERS].sort(), required('DatabaseMetadata'));
    assert.deepEqual([...shapes.DB_CHECKSUMS_MEMBERS].sort(), required('DbChecksums'));
    assert.deepEqual([...shapes.DOWNLOAD_MEMBERS].sort(), required('Download'));
});

// Digits, or one of RFC 9110's three date forms in GMT, and nothing else.
test('a Retry-After is seconds or an HTTP date and nothing else', async () => {
    const at = (offset) => new Date(Date.now() + offset);
    const day = (d) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()];
    const forms = {
        imf: (d) => d.toUTCString(),
        rfc850: (d) => {
            const [, dd, mon, yyyy, time] = d.toUTCString().split(' ');
            return `${day(d)}, ${dd}-${mon}-${yyyy.slice(2)} ${time} GMT`;
        },
        asctime: (d) => {
            const [wkd, , mon, yyyy, time] = d.toUTCString().split(' ');
            return `${wkd.slice(0, 3)} ${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${time} ${yyyy}`;
        },
    };
    const throttled = (value) => () => new Response('{"error":"slow down"}', {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': value() },
    });
    for (const [form, format] of Object.entries(forms)) {
        // Computed when its case runs: a date fixed up front can pass before it is served.
        const c = rawClient(throttled(() => format(at(10_000))), { retries: 0 });
        await assert.rejects(() => c.client.lookup(IP), (err) => {
            assert.equal(err.kind, 'rate_limited', form);
            assert.ok(err.retryAfterSeconds >= 8 && err.retryAfterSeconds <= 11, `${form}: ${err.retryAfterSeconds}`);
            return true;
        });
    }
    for (const value of ['7', '0']) {
        const c = rawClient(throttled(() => value), { retries: 0 });
        await assert.rejects(() => c.client.lookup(IP), (err) => {
            assert.equal(err.kind, 'rate_limited', value);
            assert.equal(err.retryAfterSeconds, Number(value));
            return true;
        });
    }
    const spent = [
        '+1', '-1', 'x', 'tomorrow', '1e400', '0x10', '0b11', '1_0', '1e3', '1.5', '2099-01-01',
        '2099-01-01T00:00:00', 'Jan 1 2099', 'Sun, 31 Nov 2099 08:49:37 GMT', 'Fri, 01 Jan 2099 00:00:00 PST',
        'Fri, 01 Jan 2099 00:00:00 +0500', 'Fri, 01 Jan 2099 24:00:00 GMT', 'Xyz, 01 Jan 2099 00:00:00 GMT',
    ];
    for (const value of spent) {
        const c = rawClient(throttled(() => value));
        await assert.rejects(() => c.client.lookup(IP), (err) => {
            assert.equal(err.kind, 'quota_exceeded', value);
            return true;
        });
        assert.equal(c.calls.length, 1, value);
    }
});
