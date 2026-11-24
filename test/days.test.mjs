// The twelve day members spec 2026.11.23 marked `format: date`: `first_seen` and
// `last_seen` on `bot`, `ssh`, `smtp`, each `web` row, `dns_resolver` and
// `bittorrent`. Through 5.19.2 each was checked as a string alone, so `x`,
// `tomorrow` or 30 February came back as served. Each stays a string; only its
// form is checked, as for every other date member.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VPNDetection } from '../dist/index.js';

const IP = '45.83.91.1';

function serving(answer) {
    let calls = 0;
    const client = new VPNDetection({
        apiKey: 'test-key', cache: false, retries: 1,
        fetch: async () => {
            calls++;
            return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    return { client: client, calls: () => calls };
}

const days = { first_seen: '2026-10-01', last_seen: '2026-11-23' };
const ANSWER = {
    ip: IP, is_vpn: false, is_bot: true, is_ssh: true, is_smtp: true, is_web: true, is_dns_resolver: true,
    is_bittorrent: true,
    bot: {
        provider: 'google', provider_name: 'Google', agents: ['Googlebot'], categories: ['search'], verified: true,
        identity: 'googlebot', verified_by: 'rdns', confidence: 'high', ...days,
    },
    ssh: { port: 22, banner: 'SSH-2.0-OpenSSH_9.6', host_key_fp: 'SHA256:x', session_ok: true, ...days },
    smtp: { port: 25, banner: '220 mx ESMTP', session_ok: true, ...days },
    web: [{
        port: 443, tls_ok: true, session_ok: true, status_code: 200, server: 'nginx', location: '', title: 'Home',
        cert_subject_cn: 'example.com', cert_subject_o: '', cert_issuer_dn: 'CN=R11', cert_browser_trusted: true,
        tls_version: 'TLS 1.3', ...days,
    }],
    dns_resolver: { port: 53, recursion_available: true, rcode: 0, answer_correct: true, ...days },
    bittorrent: {
        verified: true, id_matches_ip: true, ...days, last_reachable: '', days_seen: 3, num_ports: 1,
        peak_num_ports: 1, indexer: false, clients: ['qBittorrent'],
    },
};

// The answer with one member replaced: `web` is a list, so its row is replaced.
function withDay(detail, member, value) {
    if (detail === 'web') {
        return { ...ANSWER, web: [{ ...ANSWER.web[0], [member]: value }] };
    }
    return { ...ANSWER, [detail]: { ...ANSWER[detail], [member]: value } };
}

async function refused(name, answer) {
    const s = serving(answer);
    await assert.rejects(() => s.client.lookup(IP), (err) => {
        assert.equal(err.kind, 'server_error', `${name}: ${err.message}`);
        assert.equal(err.status, 200, name);
        return true;
    });
    assert.equal(s.calls(), 2, `${name} is retried`);
}

test('bot.last_seen takes the date probe, once the answer it was cut from is read', async () => {
    const s = serving(ANSWER);
    const result = await s.client.lookup(IP);
    assert.equal(result.bot.last_seen, '2026-11-23');
    assert.equal(result.web[0].first_seen, '2026-10-01');
    assert.equal(result.bittorrent.last_reachable, '');
    for (const value of ['2024-02-29', '0099-12-31']) {
        assert.equal((await serving(withDay('bot', 'last_seen', value)).client.lookup(IP)).bot.last_seen, value);
    }
    const probe = ['x', 'tomorrow', 'monday', '2026-02-30', '2026-11-23T24:00', '2026-11-23T24:00:00Z',
        '2026-11-23T10:00:00Z', '2026-11-23 10:00:00', '2026-11-23+05', '2026-11-23\n', '٢٠٢٦-11-23',
        '2026-11-٢٣', '2026-11-3', ' 2026-11-23', ''];
    await Promise.all(probe.map((value) => refused(`bot.last_seen ${JSON.stringify(value)}`,
        withDay('bot', 'last_seen', value))));
});

test('each of the twelve day members refuses a value that is not a date', async () => {
    const at = [];
    for (const detail of ['bot', 'ssh', 'smtp', 'web', 'dns_resolver', 'bittorrent']) {
        for (const member of ['first_seen', 'last_seen']) {
            at.push([detail, member]);
        }
    }
    assert.equal(at.length, 12);
    await Promise.all(at.map(([detail, member]) => refused(`${detail}.${member}`, withDay(detail, member, 'x'))));
});
