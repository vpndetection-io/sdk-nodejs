// The OAuth accessor against the shared corpus's oauth section. Nothing here
// reads oauth.deferred: those operations are not in this release.
//
// Runs against dist/, which is what actually ships.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
    OauthAccessDeniedError, OauthError, OauthExpiredTokenError, VPNDetection, VPNDetectionError,
} from '../dist/index.js';

const corpus = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8')).oauth;

const BASE_URL = 'https://api.example.test';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// Past this many requests, waits or clock reads, a loop under test fails its
// test: one that never ends would otherwise hang it while memory grows.
const LOOP_BOUND = 16;

// Satisfies every operation's required members at once.
const EVERY_REQUIRED_MEMBER = {
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    device_code: 'mo_dc_x',
    user_code: 'BCDF-GHJK',
    verification_uri: 'https://app.example.test/device',
    expires_in: 900,
    interval: 5,
    access_token: 'mo_at_x',
    token_type: 'Bearer',
};

const DEVICE = {
    device_code: 'mo_dc_x', user_code: 'BCDF-GHJK', verification_uri: 'https://app.example.test/device',
    expires_in: 900, interval: 5,
};

// In the corpus's production document, but no longer advertised or in the
// pinned spec, so it is not a member of OauthMetadata.
const NOT_A_MEMBER = new Set(['client_id_metadata_document_supported']);

test('no OAuth request carries the API key', async () => {
    const { apiKey, forbiddenHeaders, forbiddenQuery } = corpus.noCredential;
    const stub = oauthStub([{ status: 200, body: EVERY_REQUIRED_MEMBER }]);
    const client = oauthClient(stub, { apiKey: apiKey });
    fakeClock(client, stub.bound);

    const device = await client.oauth.deviceAuthorization('vpndetection-cli', { scope: 'account.read' });
    await client.oauth.metadata();
    await client.oauth.exchangeDeviceCode('vpndetection-cli', 'mo_dc_x');
    await client.oauth.exchangeRefreshToken('vpndetection-cli', 'mo_rt_x');
    await client.oauth.revoke('vpndetection-cli', 'mo_rt_x');
    assertNotError(await settle(client.oauth.pollDeviceToken('vpndetection-cli', device), stub.bound));

    assert.equal(stub.requests.length, 6);
    for (const req of stub.requests) {
        const label = `${req.method} ${req.path}`;
        for (const name of forbiddenHeaders) {
            assert.equal(req.headers.get(name), null, `${label} carried ${name}`);
        }
        for (const name of forbiddenQuery) {
            assert.equal(req.query.has(name), false, `${label} carried the ${name} query parameter`);
        }
        const leaked = req.url.includes(apiKey) || req.body.includes(apiKey)
            || [...req.headers.values()].some((value) => value.includes(apiKey));
        assert.equal(leaked, false, `${label} carried the API key`);
    }
});

// Keyless, because nothing about these operations needs a key. Every call also
// passes a timeoutMs, so an exact field match proves it stays off the wire.
test('each operation requests its endpoint with exactly its form fields', async (t) => {
    await t.test('metadata, on a base URL with a trailing slash', async () => {
        const stub = oauthStub([{ status: 200, body: EVERY_REQUIRED_MEMBER }]);
        await oauthClient(stub, { baseUrl: `${BASE_URL}/` }).oauth.metadata({ timeoutMs: 5000 });

        assert.equal(stub.requests.length, 1);
        assertEndpoint(stub.requests[0], corpus.endpoints.metadata);
        assert.equal(stub.requests[0].url, `${BASE_URL}${corpus.endpoints.metadata.path}`);
    });
    for (const c of corpus.forms.cases) {
        await t.test(c.name, async () => {
            const stub = oauthStub([{ status: 200, body: EVERY_REQUIRED_MEMBER }]);
            await callOauth(oauthClient(stub), c.operation, c.args, { timeoutMs: 5000 });

            assert.equal(stub.requests.length, 1);
            const req = stub.requests[0];
            assertEndpoint(req, corpus.endpoints[c.endpoint]);
            const type = req.headers.get('content-type') ?? '';
            assert.ok(type.startsWith(corpus.forms.contentType), `sent as ${type}`);
            assert.deepEqual(formFields(req.body), c.fields);
        });
    }
});

test('a 2xx decodes on presence: absent stays absent, an empty scope stays present', async (t) => {
    const operations = {
        metadata: 'metadata', deviceAuthorization: 'deviceAuthorization', token: 'exchangeDeviceCode',
    };
    for (const [section, operation] of Object.entries(operations)) {
        for (const c of corpus.responses[section]) {
            await t.test(`${section}: ${c.name}`, async () => {
                const stub = oauthStub([c]);
                const args = { clientId: 'vpndetection-cli', deviceCode: 'mo_dc_x' };
                const got = await callOauth(oauthClient(stub), operation, args);

                for (const [name, value] of Object.entries(c.expect.present)) {
                    if (!NOT_A_MEMBER.has(name)) {
                        assert.deepEqual(got[name], value, name);
                    }
                }
                for (const name of c.expect.absent) {
                    assert.equal(Object.hasOwn(got, name), false, `${name} must be ABSENT`);
                }
            });
        }
    }
    for (const c of corpus.responses.revoke) {
        await t.test(`revoke: ${c.name}`, async () => {
            const stub = oauthStub([c]);
            assert.equal(await oauthClient(stub).oauth.revoke('vpndetection-cli', 'mo_rt_x'), undefined);
            assert.equal(stub.requests.length, 1);
        });
    }
});

test('a 2xx that lacks a required member or does not parse is the ordinary error', async (t) => {
    const cases = {
        'missing access_token': {
            status: 200, body: { token_type: 'Bearer', expires_in: 3600 }, kind: 'server_error',
        },
        'expires_in as a string': {
            status: 200, body: { access_token: 'mo_at_x', token_type: 'Bearer', expires_in: '3600' },
            kind: 'server_error',
        },
        'not JSON': { status: 200, rawBody: '<html>', kind: 'network' },
    };
    for (const [name, reply] of Object.entries(cases)) {
        await t.test(name, async () => {
            const stub = oauthStub([reply]);
            const call = oauthClient(stub).oauth.exchangeDeviceCode('vpndetection-cli', 'mo_dc_x');
            const err = await settle(call, stub.bound);
            assertOutcome(err, { type: 'client', kind: reply.kind }, name);
            assert.equal(stub.requests.length, 1, 'an exchange is never retried');
        });
    }
});

test('a failed answer is an OAuth refusal only when it is one', async (t) => {
    for (const c of corpus.errors.cases) {
        await t.test(c.name, async () => {
            const stub = oauthStub([c]);
            const call = oauthClient(stub).oauth.exchangeDeviceCode('vpndetection-cli', 'mo_dc_x');
            const err = await settle(call, stub.bound);
            assertOutcome(err, c.expect, c.name);
        });
    }
});

test('only what consumes nothing is retried, and never an OAuth refusal', async (t) => {
    for (const c of corpus.retries.cases) {
        await t.test(c.name, async () => {
            const stub = oauthStub(c.responses);
            const outcome = await settle(callOauth(oauthClient(stub), c.operation, c.args), stub.bound);

            assert.equal(stub.requests.length, c.expect.requests, 'requests sent');
            if (c.expect.outcome === 'ok') {
                assertNotError(outcome);
                return;
            }
            assertOutcome(outcome, { ...c.expect, type: c.expect.outcome }, c.name);
        });
    }
});

// Waits are asserted exactly, through the seam that replaces the sleep AND the
// clock together, so the deadline reads the same time the waits spent.
test('pollDeviceToken waits, widens and ends as the corpus says', async (t) => {
    for (const c of corpus.poll.cases) {
        await t.test(c.name, async () => {
            const stub = oauthStub(c.responses);
            const client = oauthClient(stub);
            const waits = fakeClock(client, stub.bound);

            const outcome = await settle(client.oauth.pollDeviceToken(c.clientId, c.device), stub.bound);

            assert.deepEqual(waits, c.expect.waits, 'waits, in seconds');
            assert.equal(stub.requests.length, c.expect.requests, 'requests sent');
            const form = {
                grant_type: DEVICE_CODE_GRANT, device_code: c.device.device_code, client_id: c.clientId,
            };
            for (const req of stub.requests) {
                assertEndpoint(req, corpus.endpoints.token);
                assert.deepEqual(formFields(req.body), form);
            }
            if (c.expect.outcome === 'token') {
                assertNotError(outcome);
                assert.equal(outcome.access_token, c.expect.token?.access_token ?? outcome.access_token);
                return;
            }
            assertOutcome(outcome, { ...c.expect, type: c.expect.outcome }, c.name);
        });
    }
});

// No corpus case: the handle has to stop the real wait before the first request.
test('aborting a poll during its first wait settles at once, with the reason', async () => {
    const stub = oauthStub([{ status: 400, body: { error: 'authorization_pending' } }], 1);
    const client = oauthClient(stub, { timeoutMs: 1000 });
    const controller = new AbortController();
    const reason = new Error('the caller gave up');
    setTimeout(() => controller.abort(reason), 100);
    const started = Date.now();

    const outcome = await within(1500, settle(
        client.oauth.pollDeviceToken('vpndetection-cli', DEVICE, { signal: controller.signal }),
        stub.bound,
    ));

    assert.equal(outcome, reason);
    assert.ok(Date.now() - started < 1000, `settled ${Date.now() - started}ms after the call`);
    assert.equal(stub.requests.length, 0, 'no request after the abort');
});

test('aborting a poll during a request settles at once, with the reason', async () => {
    const stub = oauthStub([{ hang: true }], 1);
    const client = oauthClient(stub, { timeoutMs: 10_000 });
    fakeClock(client, stub.bound);
    const controller = new AbortController();
    const reason = new Error('the caller gave up');
    setTimeout(() => controller.abort(reason), 100);
    const started = Date.now();

    const outcome = await within(1500, settle(
        client.oauth.pollDeviceToken('vpndetection-cli', DEVICE, { signal: controller.signal }),
        stub.bound,
    ));

    assert.equal(outcome, reason);
    assert.ok(Date.now() - started < 1000, `settled ${Date.now() - started}ms after the call`);
    assert.equal(stub.requests.length, 1);
});

test("the client's timeoutMs bounds every OAuth request", async () => {
    const client = new VPNDetection({ retries: 0, timeoutMs: 80, fetch: () => new Promise(() => {}) });
    fakeClock(client, loopBound());
    const calls = {
        'metadata': () => client.oauth.metadata(),
        'deviceAuthorization': () => client.oauth.deviceAuthorization('vpndetection-cli'),
        'exchangeDeviceCode': () => client.oauth.exchangeDeviceCode('vpndetection-cli', 'mo_dc_x'),
        'exchangeRefreshToken': () => client.oauth.exchangeRefreshToken('vpndetection-cli', 'mo_rt_x'),
        'revoke': () => client.oauth.revoke('vpndetection-cli', 'mo_rt_x'),
        'pollDeviceToken': () => client.oauth.pollDeviceToken('vpndetection-cli', DEVICE),
    };
    for (const [name, call] of Object.entries(calls)) {
        await assert.rejects(call, (err) => {
            assertOutcome(err, { type: 'client', kind: 'network', retryable: true }, name);
            assert.match(err.message, /timed out after 80ms/, name);
            return true;
        });
    }
});

function oauthClient(stub, options = {}) {
    return new VPNDetection({ baseUrl: BASE_URL, fetch: stub.fetch, ...options });
}

// Answers in order, repeating the last reply, and records what left the client.
// Past `limit` requests it trips the bound rather than answering.
function oauthStub(replies, limit = LOOP_BOUND, bound = loopBound()) {
    const requests = [];
    const fetchFn = async (request) => {
        if (requests.length === limit) {
            return bound.trip(`sent more than ${limit} request(s)`);
        }
        const url = new URL(request.url);
        requests.push({
            method: request.method,
            path: url.pathname,
            query: url.searchParams,
            url: request.url,
            headers: request.headers,
            body: await request.text(),
        });
        const reply = replies[Math.min(requests.length, replies.length) - 1];
        if (reply.hang) {
            return new Promise(() => {});
        }
        return new Response(reply.rawBody ?? JSON.stringify(reply.body), {
            status: reply.status, headers: { 'content-type': 'application/json' },
        });
    };
    return { fetch: fetchFn, requests: requests, bound: bound };
}

// Replaces the poll's sleep and clock together, recording each wait in seconds.
function fakeClock(client, bound) {
    const waits = [];
    let elapsed = 0;
    let reads = 0;
    client.oauth.clock = {
        now: () => {
            reads++;
            if (reads > 2 * LOOP_BOUND) {
                void bound.trip(`read the clock ${reads} times`);
            }
            return elapsed;
        },
        sleep: async (ms) => {
            if (waits.length === LOOP_BOUND) {
                return bound.trip(`waited more than ${LOOP_BOUND} times`);
            }
            waits.push(ms / 1000);
            elapsed += ms;
        },
    };
    return waits;
}

// Ends a test whose code under test does not end: `tripped` rejects, and the
// loop is handed a promise that never settles, so it stops instead of spinning.
function loopBound() {
    const bound = {};
    bound.tripped = new Promise((_, reject) => {
        bound.trip = (what) => {
            reject(new Error(`${what}: the call under test does not end`));
            return new Promise(() => {});
        };
    });
    bound.tripped.catch(() => {});
    return bound;
}

// The call's value, or the error it rejected with; a tripped bound fails the test.
function settle(call, bound) {
    return Promise.race([call.then((value) => value, (err) => err), bound.tripped]);
}

function within(ms, promise) {
    let timer;
    const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function callOauth(client, operation, args, options = {}) {
    switch (operation) {
        case 'metadata':
            return client.oauth.metadata(options);
        case 'deviceAuthorization':
            return client.oauth.deviceAuthorization(args.clientId, {
                scope: args.scope, resource: args.resource, ...options,
            });
        case 'exchangeDeviceCode':
            return client.oauth.exchangeDeviceCode(args.clientId, args.deviceCode, options);
        case 'exchangeRefreshToken':
            return client.oauth.exchangeRefreshToken(args.clientId, args.refreshToken, options);
        case 'revoke':
            return client.oauth.revoke(args.clientId, args.token, options);
        default:
            throw new Error(`the corpus names an operation this suite does not know: ${operation}`);
    }
}

function assertEndpoint(req, want) {
    assert.equal(`${req.method} ${req.path}`, `${want.method} ${want.path}`);
}

// A form body as a field map, decoded the way a server decodes it (+ is a space).
function formFields(body) {
    const fields = {};
    for (const [name, value] of new URLSearchParams(body)) {
        assert.equal(Object.hasOwn(fields, name), false, `${name} sent twice`);
        fields[name] = value;
    }
    return fields;
}

function assertNotError(outcome) {
    assert.ok(!(outcome instanceof Error), `rejected with ${outcome?.name}: ${outcome?.message}`);
}

// `type` is oauth (the base class exactly), accessDenied, expiredToken, or
// client: the ordinary error, which is never an OauthError. A null in the
// corpus is Node's absence.
function assertOutcome(err, want, label) {
    assert.ok(err instanceof VPNDetectionError, `${label}: settled with ${err}`);
    const got = `${label}: settled with ${err.name}: ${err.message}`;
    const subtype = err instanceof OauthAccessDeniedError || err instanceof OauthExpiredTokenError;
    if (want.type === 'oauth') {
        assert.ok(err instanceof OauthError && !subtype, `${got}, want the base OauthError`);
    } else if (want.type === 'accessDenied') {
        assert.ok(err instanceof OauthAccessDeniedError, `${got}, want OauthAccessDeniedError`);
    } else if (want.type === 'expiredToken') {
        assert.ok(err instanceof OauthExpiredTokenError, `${got}, want OauthExpiredTokenError`);
    } else {
        assert.equal(want.type, 'client', `${label}: unknown outcome`);
        assert.ok(!(err instanceof OauthError), `${got}, want the ordinary error`);
    }
    for (const name of ['errorCode', 'errorDescription', 'status', 'kind', 'retryable', 'message']) {
        if (name in want) {
            assert.equal(err[name], want[name] ?? undefined, `${label}: ${name}`);
        }
    }
}
