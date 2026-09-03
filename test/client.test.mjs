// The Node-specific API surface, as distinct from the shared conformance
// corpus in conformance.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { VPNDetection, isBogon } from '../dist/index.js';

const data = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8'));

// Answers slowly enough that concurrent calls overlap, and records the peak
// number in flight. Asserting the PEAK is the only way to tell a real limit
// from an option that was accepted and ignored.
function concurrencyTrackingFetch(delayMs = 20) {
    const state = { inFlight: 0, peak: 0, calls: 0 };
    const fn = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        const ip = decodeURIComponent(new URL(url).pathname.slice(1));
        state.calls++;
        state.inFlight++;
        state.peak = Math.max(state.peak, state.inFlight);
        await new Promise((r) => setTimeout(r, delayMs));
        state.inFlight--;
        return new Response(JSON.stringify({ ip: ip, is_vpn: false }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    return { fetch: fn, state: state };
}

const addrs = Array.from({ length: 12 }, (_, i) => `9.9.9.${i + 1}`);

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

    assert.equal(t.state.calls, addrs.length);
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
