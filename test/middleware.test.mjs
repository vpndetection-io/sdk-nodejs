// The framework-agnostic middleware core, against the shared corpus plus the
// Node-specific parts of it (the deadline, fail-open, the selectors).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { VPNDetection, VPNDetectionError } from '../dist/index.js';
import {
    bindSelectors, createCore, matchesCondition, missingMembers,
} from '../dist/middleware/index.js';

const data = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8'));

// The corpus speaks the wire's names so every language can read it. Only the
// top-level members are renamed here, exactly as a response is: the detail
// objects keep their wire keys in this SDK too.
const MEMBER = {
    is_vpn: 'isVpn', is_hosting: 'isHosting', is_relay: 'isRelay', is_tor: 'isTor',
    is_cdn: 'isCdn', is_resproxy: 'isResproxy', is_dcproxy: 'isDcproxy', is_mobproxy: 'isMobproxy',
};

function toIdiom(condition) {
    if (Array.isArray(condition)) {
        return condition.map(toIdiom);
    }
    return Object.fromEntries(
        Object.entries(condition).map(([k, v]) => [MEMBER[k] ?? k, v]),
    );
}

function clientServing(body, options = {}) {
    return new VPNDetection({
        cache: false,
        ...options,
        fetch: async () => new Response(JSON.stringify(body), {
            status: 200, headers: { 'content-type': 'application/json' },
        }),
    });
}

async function resultFor(c) {
    if (c.bogon !== undefined) {
        return new VPNDetection().lookup(c.bogon);
    }
    return clientServing(c.body).lookup(c.body.ip);
}

for (const c of data.middleware.conditions) {
    test(`condition: ${c.name}`, async () => {
        const result = await resultFor(c);
        const condition = toIdiom(c.condition);
        assert.equal(matchesCondition(condition, result), c.expect.blocked, c.why);
        assert.deepEqual(
            missingMembers(condition, result).sort(),
            c.expect.missing.map((m) => MEMBER[m] ?? m).sort(),
            c.why,
        );
    });
}

for (const c of data.middleware.invalidConditions) {
    test(`invalid condition refused: ${c.name}`, () => {
        assert.throws(
            () => createCore({ blockCondition: toIdiom(c.condition) }, () => '1.1.1.1'),
            /constrains nothing/,
            c.why,
        );
    });
}

// A request shaped like the least a framework can offer, so the core is
// exercised without one.
function req(headers = {}, ip = '45.83.91.1') {
    return { headers: headers, ip: ip };
}

const view = (r) => ({
    header: (name) => r.headers[name.toLowerCase()],
    frameworkIp: () => r.ip,
});
const { defaultIpSelector, xffIpSelector, headerIpSelector } = bindSelectors(view);

test('enriches without blocking when no condition is configured', async () => {
    const core = createCore({ client: clientServing({ ip: '45.83.91.1', is_vpn: true }) },
        defaultIpSelector);
    const out = await core.evaluate(req());
    assert.equal(out.blocked, false);
    assert.equal(out.result.isVpn, true);
    assert.equal(out.ip, '45.83.91.1');
});

test('skip claims the request and costs no lookup', async () => {
    let calls = 0;
    const client = new VPNDetection({
        fetch: async () => {
            calls++;
            return new Response('{}', { status: 200 });
        },
    });
    const core = createCore({ client: client, skip: () => true }, defaultIpSelector);
    assert.equal(await core.evaluate(req()), undefined);
    assert.equal(calls, 0);
});

test('fails open on a lookup error, and closed only when asked', async () => {
    const failing = new VPNDetection({
        retries: 0,
        fetch: async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    });
    const open = createCore({ client: failing, blockCondition: { isVpn: true } }, defaultIpSelector);
    const a = await open.evaluate(req());
    assert.equal(a.blocked, false);
    assert.equal(a.error.kind, 'server_error');
    assert.equal(a.result, undefined);

    const closed = createCore(
        { client: failing, blockCondition: { isVpn: true }, failClosed: true }, defaultIpSelector,
    );
    assert.equal((await closed.evaluate(req())).blocked, true);
});

test('a quota refusal still fails open', async () => {
    const spent = new VPNDetection({
        retries: 0,
        fetch: async () => new Response(JSON.stringify({ error: 'monthly quota exceeded' }),
            { status: 429 }),
    });
    const core = createCore({ client: spent, blockCondition: { isVpn: true } }, defaultIpSelector);
    const out = await core.evaluate(req());
    assert.equal(out.error.kind, 'quota_exceeded');
    assert.equal(out.blocked, false);
});

test('the deadline bounds the request even when the transport ignores it', async () => {
    const hung = new VPNDetection({
        retries: 0,
        cache: false,
        fetch: () => new Promise(() => {}),
    });
    const core = createCore({ client: hung, timeoutMs: 120 }, defaultIpSelector);
    const started = Date.now();
    const out = await core.evaluate(req());
    const took = Date.now() - started;
    assert.equal(out.error.kind, 'network');
    assert.match(out.error.message, /timed out after 120ms/);
    assert.equal(out.blocked, false);
    assert.ok(took < 2000, `took ${took}ms, so the budget did not hold`);
});

test('a bogon client address warns once and never reaches the network', async () => {
    let calls = 0;
    const client = new VPNDetection({
        fetch: async () => {
            calls++;
            return new Response('{}', { status: 200 });
        },
    });
    const warnings = [];
    const core = createCore(
        { client: client, onWarn: (m) => warnings.push(m) }, defaultIpSelector,
    );
    await core.evaluate(req({}, '10.0.0.7'));
    await core.evaluate(req({}, '10.0.0.7'));
    assert.equal(calls, 0);
    assert.equal(warnings.length, 1, 'a per-request warning is an outage of its own');
    assert.match(warnings[0], /not a public address/);
});

test('a missing member is warned about once, or thrown on request', async () => {
    const free = clientServing({ ip: '45.83.91.1', is_vpn: true });
    const warnings = [];
    const warned = createCore({
        client: free, blockCondition: { isHosting: true }, onWarn: (m) => warnings.push(m),
    }, defaultIpSelector);
    assert.equal((await warned.evaluate(req())).blocked, false);
    await warned.evaluate(req({}, '45.83.91.2'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /isHosting/);

    const strict = createCore({
        client: free, blockCondition: { isHosting: true }, onMissingField: 'throw',
    }, defaultIpSelector);
    await assert.rejects(() => strict.evaluate(req()), /does not include/);

    const quiet = createCore({
        client: free, blockCondition: { isHosting: true }, onMissingField: 'ignore',
        onWarn: () => assert.fail('ignore must not warn'),
    }, defaultIpSelector);
    assert.equal((await quiet.evaluate(req())).blocked, false);
});

test('selectors read what they say they read', () => {
    const r = req({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' }, '10.0.0.1');
    assert.equal(defaultIpSelector(r), '10.0.0.1');
    assert.equal(xffIpSelector()(r), '203.0.113.9');
    assert.equal(xffIpSelector({ depth: 1 })(r), '150.172.238.178');
    assert.equal(xffIpSelector({ depth: 2 })(r), '70.41.3.18');
    assert.equal(headerIpSelector('CF-Connecting-IP')(r), '10.0.0.1');

    const cf = req({ 'cf-connecting-ip': '198.51.100.4' }, '10.0.0.1');
    assert.equal(headerIpSelector('CF-Connecting-IP')(cf), '198.51.100.4');
    assert.equal(xffIpSelector()(req({}, '10.0.0.1')), '10.0.0.1');
});

test('an unresolvable address warns and does not block', async () => {
    const warnings = [];
    const core = createCore(
        { blockCondition: { isVpn: true }, onWarn: (m) => warnings.push(m) },
        () => undefined,
    );
    const out = await core.evaluate(req());
    assert.equal(out.blocked, false);
    assert.equal(out.error.kind, 'bad_request');
    assert.match(warnings[0], /could not resolve a client address/);
});

test('an injected client is used rather than a second one built', async () => {
    let calls = 0;
    const shared = new VPNDetection({
        fetch: async (input) => {
            calls++;
            const ip = decodeURIComponent(new URL(typeof input === 'string' ? input : input.url)
                .pathname.slice(1));
            return new Response(JSON.stringify({ ip: ip, is_vpn: true }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        },
    });
    const core = createCore({ client: shared }, defaultIpSelector);
    await core.evaluate(req());
    await core.evaluate(req());
    assert.equal(calls, 1, 'the second request should have hit the shared cache');
    assert.equal((await shared.lookup('45.83.91.1')).isVpn, true);
    assert.equal(calls, 1);
});

test('a timeout is a VPNDetectionError, not a raw AbortError', async () => {
    const hung = new VPNDetection({ retries: 0, fetch: () => new Promise(() => {}) });
    await assert.rejects(
        () => hung.lookup('45.83.91.1', { timeoutMs: 80 }),
        (err) => err instanceof VPNDetectionError && err.kind === 'network' && err.retryable,
    );
});
