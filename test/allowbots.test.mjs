// `allowBots`: a crawler's User-Agent sent with its lookup, at most four an address, and a verified
// crawler let through whatever the condition matches. Every request here comes
// from a public peer, since a bogon is answered locally and would pass vacuously.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { VPNDetection } from '../dist/index.js';
import { bindSelectors, createCore, MAX_AGENTS_PER_ADDRESS, namesCrawler } from '../dist/middleware/index.js';

const CORPUS = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8')).crawlerAgents;

const PEER = '66.249.66.1';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// A request as an adapter sees it: headers by lowercase name and the socket peer.
const view = (req) => ({ header: (name) => req.headers[name.toLowerCase()], frameworkIp: () => req.ip });
const selectors = bindSelectors(view);
const request = (headers = { 'user-agent': GOOGLEBOT }, ip = PEER) => ({ ip: ip, headers: headers });
const crawler = (n) => `Mozilla/5.0 (compatible; Examplebot/${n}.0)`;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

// A bot's address, answering `verdict` for any agent that arrives, and recording what arrived.
function origin(verdict, bot = undefined) {
    const agents = [];
    const fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : new Request(input, init).url);
        const agent = url.searchParams.get('user_agent');
        agents.push(agent);
        const body = {
            ip: url.pathname.split('/').pop(), is_vpn: false, is_bot: true,
            ...(bot === undefined ? {} : { bot: bot }),
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

test('only an agent naming a crawler is sent, as the corpus says', async () => {
    assert.ok(CORPUS.crawlers.length > 0 && CORPUS.others.length > 0);
    for (const ua of CORPUS.crawlers) {
        assert.equal(namesCrawler(ua), true, ua);
    }
    for (const ua of CORPUS.others) {
        assert.equal(namesCrawler(ua), false, ua);
    }
    for (const term of CORPUS.terms) {
        assert.equal(namesCrawler(`x ${term.toUpperCase()} y`), true, term);
    }
    const o = origin('not_bot');
    const lookup = await core(o, { allowBots: true }).evaluate(request({ 'user-agent': CHROME }));
    assert.deepEqual(o.agents, [null], 'a browser\'s agent stays off the lookup');
    assert.equal(lookup.blocked, true);
});

test('one address is looked up with at most four crawler agents, and none passes past them', async () => {
    assert.equal(MAX_AGENTS_PER_ADDRESS, 4);
    const o = origin('verified');
    const c = core(o, { allowBots: true });
    for (let n = 1; n <= 4; n++) {
        assert.equal((await c.evaluate(request({ 'user-agent': crawler(n) }))).blocked, false, `agent ${n}`);
    }
    const past = await c.evaluate(request({ 'user-agent': crawler(5) }));
    assert.equal(past.blocked, true, 'an agent past the bound is never let through as verified');
    assert.equal(past.result.userAgent, undefined);
    assert.equal((await c.evaluate(request({ 'user-agent': crawler(1) }))).blocked, false, 'a known agent is still sent');
    assert.deepEqual(o.agents, [crawler(1), crawler(2), crawler(3), crawler(4), null, crawler(1)]);

    const other = await c.evaluate(request({ 'user-agent': crawler(5) }, '66.249.66.2'));
    assert.equal(other.blocked, false, 'each address has its own bound');
    assert.equal(o.agents.at(-1), crawler(5));
});

test('past the bound, an address its operator vouches for still passes', async () => {
    const o = origin('verified', { verified: true });
    const c = core(o, { allowBots: true });
    for (let n = 1; n <= 5; n++) {
        assert.equal((await c.evaluate(request({ 'user-agent': crawler(n) }))).blocked, false, `agent ${n}`);
    }
    assert.equal(o.agents.at(-1), null);
    const browser = await c.evaluate(request({ 'user-agent': CHROME }));
    assert.equal(browser.blocked, true, 'a browser on that address is judged as the condition says');
});

test('allowBots is checked when the middleware is built', () => {
    const o = origin('verified');
    assert.throws(() => createCore({ client: o.client, allowBots: true }, selectors.defaultIpSelector),
        /User-Agent/);
    assert.throws(() => core(o, { allowBots: 'yes' }), /allowBots/);
});
