// Asserts the shared conformance corpus that every VPNDetection SDK asserts.
//
// The corpus is generated into testdata/ and is identical across languages, so
// a behaviour that drifts here fails here rather than surfacing as two client
// libraries quietly disagreeing about the same address.
//
// Runs against dist/, which is what actually ships.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { VPNDetection, VPNDetectionError, isBogon } from '../dist/index.js';

const data = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8'));

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// A fetch stand-in that answers from a table and counts what it was asked for,
// so "never touched the network" is asserted rather than assumed.
function stubFetch(routes) {
    const calls = [];
    const fn = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        calls.push(url);
        const ip = decodeURIComponent(new URL(url).pathname.slice(1));
        const r = routes[ip];
        if (r === undefined) {
            return new Response(JSON.stringify({ error: 'not a valid IP address' }), {
                status: 400, headers: { 'content-type': 'application/json' },
            });
        }
        return new Response(JSON.stringify(r.body), {
            status: r.status ?? 200,
            headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
        });
    };
    return { fetch: fn, calls: calls };
}

test('isBogon matches the canonical ranges', () => {
    for (const c of data.isBogon) {
        assert.equal(isBogon(c.ip), c.expect, `${c.ip} (${c.why})`);
    }
});

test('a bogon is answered locally in the full max shape', async () => {
    const stub = stubFetch({});
    const c = new VPNDetection({ fetch: stub.fetch });
    const r = await c.lookup('10.0.0.1');

    assert.equal(r.isBogon, true);
    assert.equal(r.ip, '10.0.0.1');
    for (const f of data.bogonResponse.flagsFalse) {
        assert.equal(r[camel(f)], false, `${f} must be present and false`);
    }
    for (const o of data.bogonResponse.emptyObjects) {
        assert.deepEqual(r[camel(o)], {}, `${o} must be present and empty`);
    }
    assert.equal(stub.calls.length, 0, 'a bogon must not reach the network');
});

test('lookup preserves absent-versus-false across every plan shape', async () => {
    for (const c of data.lookup) {
        const stub = stubFetch({ [c.body.ip]: { status: c.status, body: c.body } });
        const client = new VPNDetection({ fetch: stub.fetch });
        const r = await client.lookup(c.body.ip);

        assert.equal(r.ip, c.expect.ip, c.name);
        assert.equal(r.isBogon, c.expect.isBogon, c.name);

        for (const [k, v] of Object.entries(c.expect.present ?? {})) {
            assert.equal(r[camel(k)], v, `${c.name}: ${k} should be ${v}`);
        }
        for (const k of c.expect.absent ?? []) {
            assert.equal(r[camel(k)], undefined, `${c.name}: ${k} must be ABSENT, not false`);
        }
        for (const k of c.expect.emptyPresent ?? []) {
            assert.deepEqual(r[camel(k)], {}, `${c.name}: ${k} must be present and empty`);
        }
        for (const obj of ['vpn', 'hosting', 'dcproxy']) {
            if (c.expect[obj] !== undefined) {
                assert.deepEqual(r[obj], c.expect[obj], `${c.name}: ${obj}`);
            }
        }
    }
});

test('a 429 is classified by Retry-After, not by its status', async () => {
    for (const c of data.errors) {
        const stub = stubFetch({
            '1.1.1.1': { status: c.status, body: c.body, headers: c.headers },
        });
        // No retries, so a retryable error still surfaces rather than looping.
        const client = new VPNDetection({ fetch: stub.fetch, retries: 0 });
        await assert.rejects(
            () => client.lookup('1.1.1.1'),
            (err) => {
                assert.ok(err instanceof VPNDetectionError, `${c.name}: wrong error type`);
                assert.equal(err.kind, c.expect.kind, c.name);
                assert.equal(err.retryable, c.expect.retryable, `${c.name}: retryable`);
                if (c.expect.message !== undefined) {
                    assert.equal(err.message, c.expect.message, `${c.name}: message`);
                }
                if (c.expect.retryAfterSeconds !== undefined) {
                    assert.equal(err.retryAfterSeconds, c.expect.retryAfterSeconds, c.name);
                }
                return true;
            },
        );
    }
});

test('batch dedupes, short-circuits bogons and keys by address', async () => {
    const c = data.batch.find((b) => b.name === 'dedup-bogon-and-order-free-keying');
    const stub = stubFetch({
        '1.1.1.1': { body: { ip: '1.1.1.1', is_vpn: false } },
        '8.8.8.8': { body: { ip: '8.8.8.8', is_vpn: false } },
    });
    const client = new VPNDetection({ fetch: stub.fetch });
    const got = await client.lookupBatch(c.input);

    assert.deepEqual([...got.keys()], c.expect.keys);
    assert.equal(stub.calls.length, c.expect.httpRequests);
    for (const k of c.expect.bogonKeys) {
        assert.equal(got.get(k).isBogon, true, `${k} should be a local answer`);
    }
});

test('one bad address does not lose the rest of the batch', async () => {
    const c = data.batch.find((b) => b.name === 'partial-failure-does-not-fail-the-batch');
    const stub = stubFetch({ '1.1.1.1': { body: { ip: '1.1.1.1', is_vpn: false } } });
    const client = new VPNDetection({ fetch: stub.fetch, retries: 0 });
    const got = await client.lookupBatch(c.input);

    assert.deepEqual([...got.keys()], c.expect.keys);
    for (const k of c.expect.errorKeys) {
        assert.ok(got.get(k) instanceof VPNDetectionError, `${k} should carry its error`);
    }
    assert.equal(got.get('1.1.1.1').isVpn, false, 'the good address still answered');
});

test('a cache hit issues no second request', async () => {
    const c = data.batch.find((b) => b.name === 'cache-hit-issues-no-second-request');
    const stub = stubFetch({ '1.1.1.1': { body: { ip: '1.1.1.1', is_vpn: false } } });
    const client = new VPNDetection({ fetch: stub.fetch });

    for (let i = 0; i < c.repeat; i++) {
        await client.lookupBatch(c.input);
    }
    assert.equal(stub.calls.length, c.expect.httpRequests);
});

test('two clients never share a cached answer', async () => {
    const stub = stubFetch({ '1.1.1.1': { body: { ip: '1.1.1.1', is_vpn: false } } });
    const a = new VPNDetection({ fetch: stub.fetch, apiKey: 'key-a' });
    const b = new VPNDetection({ fetch: stub.fetch, apiKey: 'key-b' });

    await a.lookup('1.1.1.1');
    await b.lookup('1.1.1.1');
    // Two keys can be on different plans and so entitled to different fields;
    // a shared cache would serve one of them the other's shape.
    assert.equal(stub.calls.length, 2);
});

test('caching can be turned off', async () => {
    const stub = stubFetch({ '1.1.1.1': { body: { ip: '1.1.1.1', is_vpn: false } } });
    const client = new VPNDetection({ fetch: stub.fetch, cache: false });
    await client.lookup('1.1.1.1');
    await client.lookup('1.1.1.1');
    assert.equal(stub.calls.length, 2);
});
