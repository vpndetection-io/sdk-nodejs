// `allowBots`: the request's own User-Agent sent with its lookup, and a verified
// crawler let through whatever the condition matches. Every request here comes
// from a public peer, since a bogon is answered locally and would pass vacuously.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VPNDetection } from '../dist/index.js';
import { bindSelectors, createCore } from '../dist/middleware/index.js';

const PEER = '66.249.66.1';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// A request as an adapter sees it: headers by lowercase name and the socket peer.
const view = (req) => ({ header: (name) => req.headers[name.toLowerCase()], frameworkIp: () => req.ip });
const selectors = bindSelectors(view);
const request = (headers = { 'user-agent': GOOGLEBOT }) => ({ ip: PEER, headers: headers });

// A bot's address, answering `verdict` for any agent that arrives, and recording what arrived.
function origin(verdict) {
    const agents = [];
    const fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : new Request(input, init).url);
        const agent = url.searchParams.get('user_agent');
        agents.push(agent);
        const body = {
            ip: PEER, is_vpn: false, is_bot: true,
            ...(agent === null || verdict === undefined ? {} : { user_agent: { agent: 'Googlebot', kind: 'bot', verdict: verdict } }),
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { agents: agents, client: new VPNDetection({ apiKey: 'k', fetch: fetch, cache: false }) };
}

function core(o, options = {}) {
    return createCore({ client: o.client, blockCondition: { isBot: true }, onWarn: () => {}, ...options },
        selectors.defaultIpSelector, selectors.userAgentSelector);
}

test('allowBots sends the request\'s own User-Agent, and a verified crawler passes a condition it meets', async () => {
    const o = origin('verified');
    const lookup = await core(o, { allowBots: true }).evaluate(request());
    assert.deepEqual(o.agents, [GOOGLEBOT], 'the agent that reached the origin is the request\'s own');
    assert.equal(lookup.blocked, false);
    assert.equal(lookup.result.isBot, true, 'the answer is still attached');
    assert.equal(lookup.result.userAgent.verdict, 'verified');
});

test('a spoofed, unverifiable or not_bot verdict is refused as the condition says', async () => {
    for (const verdict of ['spoofed', 'unverifiable', 'not_bot']) {
        const o = origin(verdict);
        const lookup = await core(o, { allowBots: true }).evaluate(request());
        assert.deepEqual(o.agents, [GOOGLEBOT], verdict);
        assert.equal(lookup.blocked, true, verdict);
        assert.equal(lookup.result.userAgent.verdict, verdict);
    }
});

test('a condition on the verdict refuses a forged crawler', async () => {
    const o = origin('spoofed');
    const c = core(o, { allowBots: true, blockCondition: { userAgent: { verdict: 'spoofed' } } });
    assert.equal((await c.evaluate(request())).blocked, true);
    const v = origin('not_bot');
    const d = core(v, { allowBots: true, blockCondition: { userAgent: { verdict: 'spoofed' } } });
    assert.equal((await d.evaluate(request())).blocked, false);
});

test('off, no agent is sent and a bot is refused as the condition says', async () => {
    for (const options of [{}, { allowBots: false }]) {
        const o = origin('verified');
        const lookup = await core(o, options).evaluate(request());
        assert.deepEqual(o.agents, [null]);
        assert.equal(lookup.blocked, true);
        assert.equal(lookup.result.userAgent, undefined);
    }
    const on = origin('verified');
    assert.equal((await core(on, { allowBots: true }).evaluate(request())).blocked, false);
    assert.deepEqual(on.agents, [GOOGLEBOT], 'the same request with allowBots on sends it');
});

test('an absent or empty User-Agent sends none', async () => {
    for (const headers of [{}, { 'user-agent': '' }]) {
        const o = origin('verified');
        const lookup = await core(o, { allowBots: true }).evaluate(request(headers));
        assert.deepEqual(o.agents, [null], JSON.stringify(headers));
        assert.equal(lookup.blocked, true);
        await core(o, { allowBots: true }).evaluate(request());
        assert.deepEqual(o.agents, [null, GOOGLEBOT], 'the same core sends a header that is there');
    }
});

test('a served answer with no verdict is reported once under onMissingField', async () => {
    const warnings = [];
    const o = origin(undefined);
    const c = core(o, { allowBots: true, onWarn: (m) => warnings.push(m) });
    assert.equal((await c.evaluate(request())).blocked, true);
    assert.equal((await c.evaluate(request())).blocked, true);
    assert.deepEqual(o.agents, [GOOGLEBOT, GOOGLEBOT]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /userAgent verdict/);

    const quiet = [];
    await core(origin(undefined), { allowBots: true, onMissingField: 'ignore', onWarn: (m) => quiet.push(m) })
        .evaluate(request());
    assert.deepEqual(quiet, []);
    await assert.rejects(() => core(origin(undefined), { allowBots: true, onMissingField: 'throw' }).evaluate(request()),
        /userAgent verdict/);

    // No agent sent, nothing to lack: the header absent, or allowBots off.
    const none = [];
    await core(origin(undefined), { allowBots: true, onWarn: (m) => none.push(m) }).evaluate(request({}));
    await core(origin(undefined), { onWarn: (m) => none.push(m) }).evaluate(request());
    assert.deepEqual(none, []);
});

test('allowBots is checked when the middleware is built', () => {
    const o = origin('verified');
    assert.throws(() => createCore({ client: o.client, allowBots: true }, selectors.defaultIpSelector),
        /User-Agent/);
    assert.throws(() => core(o, { allowBots: 'yes' }), /allowBots/);
});
