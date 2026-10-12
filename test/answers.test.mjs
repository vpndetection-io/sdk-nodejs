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
