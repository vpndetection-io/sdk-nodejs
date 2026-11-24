// A user agent sent with a lookup, `myIp` and a batch, and the verdict it brings
// back. Through 5.19.2 none was sent: the option did not exist, and the answer's
// `user_agent` was dropped.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VPNDetection } from '../dist/index.js';

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const VERDICT = { agent: 'Googlebot', kind: 'bot', verdict: 'verified' };

// Records each request and answers each address, with a verdict naming the agent
// that arrived when one did, after `delayMs` so concurrent calls overlap.
function origin(delayMs = 0) {
    const requests = [];
    const answer = (ip, agent) => ({
        ip: ip, is_vpn: false, ...(agent === undefined ? {} : { user_agent: { ...VERDICT, agent: agent } }),
    });
    const fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        const body = request.method === 'POST' ? JSON.parse(await request.text()) : undefined;
        requests.push({ url: request.url, path: url.pathname, agent: url.searchParams.get('user_agent'), body: body });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        let served;
        if (body === undefined) {
            const ip = url.pathname === '/myip' ? '203.0.113.9' : decodeURIComponent(url.pathname.slice(1));
            served = answer(ip, url.searchParams.get('user_agent') ?? undefined);
        } else {
            served = {
                results: Object.fromEntries(body.ips.map((ip) => [ip, answer(ip, body.user_agents?.[ip])])), errors: {},
            };
        }
        return new Response(JSON.stringify(served), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { requests: requests, fetch: fetch };
}

test('a lookup sends its agent percent-encoded, and the answer carries the verdict', async () => {
    const o = origin();
    const client = new VPNDetection({ apiKey: 'k', fetch: o.fetch });
    const agent = `${GOOGLEBOT} a&b=c#d?e!*'`;
    const result = await client.lookup('66.249.66.1', { userAgent: agent });
    assert.equal(o.requests.length, 1);
    assert.equal(o.requests[0].agent, agent, 'the agent arrives whole');
    const query = new URL(o.requests[0].url).search;
    assert.match(query, /^\?user_agent=[A-Za-z0-9%._~-]+$/, 'every reserved character is percent-encoded');
    assert.match(query, /%2Bhttp%3A%2F%2F/, 'the + is encoded, so it is not read as a space');
    assert.deepEqual(result.userAgent, { ...VERDICT, agent: agent });
    assert.deepEqual(result.raw.user_agent, { ...VERDICT, agent: agent });

    const plain = await client.lookup('66.249.66.2');
    assert.equal(o.requests[1].agent, null, 'no agent, no parameter');
    assert.equal(plain.userAgent, undefined);
    assert.equal(await client.lookup('66.249.66.3', { userAgent: '' }).then((r) => r.userAgent), undefined);
    assert.equal(o.requests[2].agent, null, 'the empty agent is none');
});

test('an agent longer than 1024 characters is sent whole', async () => {
    const o = origin();
    const client = new VPNDetection({ apiKey: 'k', fetch: o.fetch });
    const agent = `${GOOGLEBOT} ${'x'.repeat(2000)}`;
    await client.lookup('66.249.66.1', { userAgent: agent });
    await client.myIp({ userAgent: agent });
    await client.lookupBatch(['66.249.66.2', '66.249.66.3'], { userAgents: { '66.249.66.2': agent } });
    assert.equal(o.requests[0].agent, agent);
    assert.equal(o.requests[1].agent, agent);
    assert.deepEqual(o.requests[2].body.user_agents, { '66.249.66.2': agent });
});

test('the cache keys on the address and the agent together', async () => {
    const o = origin();
    const client = new VPNDetection({ apiKey: 'k', fetch: o.fetch });
    const a = await client.lookup('66.249.66.1', { userAgent: 'A' });
    const b = await client.lookup('66.249.66.1', { userAgent: 'B' });
    const none = await client.lookup('66.249.66.1');
    assert.equal(o.requests.length, 3, 'two agents and none are three requests');
    assert.equal(a.userAgent.agent, 'A');
    assert.equal(b.userAgent.agent, 'B');
    assert.equal(none.userAgent, undefined);
    assert.equal((await client.lookup('66.249.66.1', { userAgent: 'A' })).userAgent.agent, 'A');
    assert.equal((await client.lookup('66.249.66.1', { userAgent: 'B' })).userAgent.agent, 'B');
    assert.equal((await client.lookup('66.249.66.1')).userAgent, undefined);
    assert.equal(o.requests.length, 3, 'the same pair again is a hit');
});

test('concurrent misses for one address and agent share one request, and only those', async () => {
    const o = origin(30);
    const client = new VPNDetection({ apiKey: 'k', fetch: o.fetch });
    const results = await Promise.all([
        ...Array.from({ length: 5 }, () => client.lookup('66.249.66.1', { userAgent: 'A' })),
        ...Array.from({ length: 3 }, () => client.lookup('66.249.66.1', { userAgent: 'B' })),
        client.lookupBatch(['66.249.66.1'], { userAgents: { '66.249.66.1': 'A' } }).then((m) => m.get('66.249.66.1')),
    ]);
    assert.equal(o.requests.length, 2, 'one request per pair');
    assert.deepEqual(results.map((r) => r.userAgent.agent), ['A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'A']);
});

test('a batch sends user_agents keyed as sent, only from a chunk where an address has one', async () => {
    const o = origin();
    const client = new VPNDetection({ apiKey: 'k', fetch: o.fetch, cache: false });
    const answers = await client.lookupBatch(['66.249.66.1', '::ffff:66.249.66.2', '66.249.66.3', '10.0.0.1'], {
        userAgents: { '66.249.66.1': 'A', '::ffff:66.249.66.2': 'B', '66.249.66.3': '', '10.0.0.1': 'C' },
    });
    assert.equal(o.requests.length, 1);
    assert.deepEqual(o.requests[0].body, {
        ips: ['66.249.66.1', '66.249.66.2', '66.249.66.3'], user_agents: { '66.249.66.1': 'A', '66.249.66.2': 'B' },
    });
    assert.equal(answers.get('66.249.66.1').userAgent.agent, 'A');
    assert.equal(answers.get('::ffff:66.249.66.2').userAgent.agent, 'B');
    assert.equal(answers.get('66.249.66.3').userAgent, undefined);
    assert.equal(answers.get('10.0.0.1').userAgent, undefined, 'a bogon stays local and carries none');

    await client.lookupBatch(['66.249.66.1', '66.249.66.3'], { userAgents: new Map([['66.249.66.1', 'A']]) });
    assert.deepEqual(o.requests[1].body.user_agents, { '66.249.66.1': 'A' }, 'a Map works as a record does');
    await client.lookupBatch(['66.249.66.1', '66.249.66.3']);
    await client.lookupBatch(['66.249.66.1', '66.249.66.3'], { userAgents: { '66.249.66.3': '' } });
    assert.ok(!('user_agents' in o.requests[2].body), 'no agents, no member');
    assert.ok(!('user_agents' in o.requests[3].body), 'only empty agents, no member');

    const many = Array.from({ length: 1001 }, (_, i) => `9.9.${Math.floor(i / 256)}.${i % 256}`);
    await client.lookupBatch(many, { userAgents: { [many[1000]]: 'A' } });
    assert.ok(!('user_agents' in o.requests[4].body), 'the chunk with no agent sends none');
    assert.deepEqual(o.requests[5].body.user_agents, { [many[1000]]: 'A' });
});

test('a batch caches each answer on its address and agent', async () => {
    const o = origin();
    const client = new VPNDetection({ apiKey: 'k', fetch: o.fetch });
    await client.lookupBatch(['66.249.66.1', '66.249.66.2'], { userAgents: { '66.249.66.1': 'A' } });
    assert.equal((await client.lookup('66.249.66.1', { userAgent: 'A' })).userAgent.agent, 'A');
    assert.equal((await client.lookup('66.249.66.2')).userAgent, undefined);
    assert.equal(o.requests.length, 1, 'both pairs were cached by the batch');
    await client.lookup('66.249.66.1');
    await client.lookup('66.249.66.2', { userAgent: 'A' });
    assert.equal(o.requests.length, 3, 'the other pairs were not');
});

test('a bogon stays local and carries no verdict, while a public address sends the same agent', async () => {
    const o = origin();
    const client = new VPNDetection({ apiKey: 'k', fetch: o.fetch });
    const bogon = await client.lookup('10.0.0.1', { userAgent: GOOGLEBOT });
    assert.equal(bogon.userAgent, undefined);
    assert.ok(!('user_agent' in bogon.raw));
    assert.equal(o.requests.length, 0);
    assert.equal((await client.lookup('66.249.66.1', { userAgent: GOOGLEBOT })).userAgent.agent, GOOGLEBOT);
    assert.equal(o.requests[0].agent, GOOGLEBOT);
});

test('myIp sends its agent and stays uncached', async () => {
    const o = origin();
    const client = new VPNDetection({ apiKey: 'k', fetch: o.fetch });
    const first = await client.myIp({ userAgent: GOOGLEBOT });
    await client.myIp({ userAgent: GOOGLEBOT });
    assert.equal(o.requests.length, 2);
    assert.equal(o.requests[0].path, '/myip');
    assert.equal(o.requests[0].agent, GOOGLEBOT);
    assert.equal(first.userAgent.agent, GOOGLEBOT);
});

test('a user agent that is not a string is refused before anything is sent', async () => {
    const o = origin();
    const client = new VPNDetection({ apiKey: 'k', fetch: o.fetch });
    for (const call of [
        () => client.lookup('66.249.66.1', { userAgent: 5 }),
        () => client.myIp({ userAgent: {} }),
        () => client.lookupBatch(['66.249.66.1'], { userAgents: { '66.249.66.1': 5 } }),
        () => client.lookupBatch(['66.249.66.1'], { userAgents: 'Googlebot' }),
    ]) {
        await assert.rejects(call, (err) => err.kind === 'bad_request');
    }
    assert.equal(o.requests.length, 0);
});

test('an unreadable verdict is a retried server_error', async () => {
    let calls = 0;
    const client = new VPNDetection({
        apiKey: 'k', cache: false, retries: 1,
        fetch: async () => {
            calls++;
            return new Response(JSON.stringify({ ip: '66.249.66.1', is_vpn: false, user_agent: { agent: 'Googlebot' } }),
                { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    await assert.rejects(() => client.lookup('66.249.66.1', { userAgent: GOOGLEBOT }), (err) => {
        assert.equal(err.kind, 'server_error');
        assert.equal(err.status, 200);
        return true;
    });
    assert.equal(calls, 2);
});
