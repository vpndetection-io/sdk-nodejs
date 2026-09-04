// The published package against the staging API.
//
// Nothing here may assert a plan tier. The key CI presents can be moved between
// plans without warning, and a suite that pins "is_hosting comes back" turns a
// billing change into a red build. What is asserted instead is the contract that
// holds on every tier: a present flag is a real boolean, an absent one is absent
// rather than false, a populated detail object carries its documented keys, and
// a keyed answer is a superset of a keyless one.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VPNDetection, isBogon } from 'vpndetection';

const STAGING = 'https://api-staging.vpndetection.io';
// Trimmed, and EMPTY counts as absent. Actions interpolates a secret that does
// not exist to an empty string rather than leaving the variable unset, and an
// empty key makes the client send no auth header at all, so a `=== undefined`
// gate lets the keyed test run as a second keyless one and pass against nothing.
const KEY = (process.env.VPNDETECTION_STAGING_KEY ?? '').trim();
const KEYLESS_ONLY = KEY === ''
    ? 'VPNDETECTION_STAGING_KEY is not set, so the keyed half of the suite cannot run'
    : false;

// A stable VPN address, and the one the README teaches. Staging is a real
// environment, so the whole file is budgeted at four requests: one here, two in
// the batch, one keyed. The client caches, so the second lookup of PROBE costs
// nothing.
const PROBE = '45.83.91.1';

const keyless = new VPNDetection({ baseUrl: STAGING });

const FLAGS = [
    'isVpn', 'isHosting', 'isRelay', 'isTor', 'isCdn', 'isResproxy', 'isDcproxy', 'isMobproxy',
];
const CLASS_KEYS = ['provider', 'confidence', 'last_seen'];
const PROXY_KEYS = [
    'provider', 'first_seen', 'last_seen', 'hits', 'hits_days_pct', 'providers_num',
];
// `required` is what a populated object carries on every tier. `optional` is the
// max-only remainder, absent rather than empty on a lower plan.
const DETAILS = {
    vpn: { required: ['provider', 'last_seen'], optional: ['confidence', 'method'] },
    hosting: { required: CLASS_KEYS, optional: [] },
    relay: { required: CLASS_KEYS, optional: [] },
    tor: { required: CLASS_KEYS, optional: [] },
    cdn: { required: CLASS_KEYS, optional: [] },
    resproxy: { required: PROXY_KEYS, optional: [] },
    dcproxy: { required: PROXY_KEYS, optional: [] },
    mobproxy: { required: PROXY_KEYS, optional: [] },
};

test('a keyless staging lookup answers ip and is_vpn', async () => {
    const r = await keyless.lookup(PROBE);

    assert.equal(r.ip, PROBE);
    assert.equal(typeof r.isVpn, 'boolean');
    assert.equal(r.raw.ip, PROBE);
    assert.equal(typeof r.raw.is_vpn, 'boolean');
    assert.equal(r.isBogon, false, 'a served answer is not a local one');
    assertTierIndependentShape(r);
});

test('a bogon is answered without touching the network', async () => {
    const offline = new VPNDetection({
        baseUrl: STAGING,
        fetch: () => {
            throw new Error('the bogon path reached the network');
        },
    });

    const r = await offline.lookup('10.0.0.1');

    assert.equal(r.isBogon, true);
    assert.equal(r.isVpn, false);
    assert.equal(isBogon('10.0.0.1'), true, 'the standalone export must agree');
    for (const flag of FLAGS) {
        assert.equal(r[flag], false, `${flag} must be present and false on a bogon`);
    }
    for (const name of Object.keys(DETAILS)) {
        assert.deepEqual(r[name], {}, `${name} must be present and empty on a bogon`);
    }
});

test('a batch collapses duplicates and keeps bogons off the wire', async () => {
    // Distinct URLs rather than a call count, so a retry against a wobbling
    // staging cannot read as a failure to deduplicate.
    const asked = new Set();
    const counting = new VPNDetection({
        baseUrl: STAGING,
        fetch: (...args) => {
            const input = args[0];
            asked.add(new URL(typeof input === 'string' ? input : input.url).pathname);
            return fetch(...args);
        },
    });

    const got = await counting.lookupBatch([PROBE, '8.8.8.8', PROBE, '10.0.0.1', '8.8.8.8']);

    assert.deepEqual([...got.keys()], [PROBE, '8.8.8.8', '10.0.0.1']);
    assert.deepEqual([...asked].sort(), [`/${PROBE}`, '/8.8.8.8'].sort());
    assert.equal(got.get('10.0.0.1').isBogon, true);
    for (const ip of [PROBE, '8.8.8.8']) {
        assert.ok(!(got.get(ip) instanceof Error), `${ip}: ${got.get(ip).message}`);
        assertTierIndependentShape(got.get(ip));
    }
});

test('a keyed answer is a superset of the keyless one', { skip: KEYLESS_ONLY }, async () => {
    let carriedTheKey = false;
    const keyed = new VPNDetection({
        baseUrl: STAGING,
        apiKey: KEY,
        fetch: (...args) => {
            carriedTheKey ||= sends(args[0], KEY);
            return fetch(...args);
        },
    });

    const withKey = await keyed.lookup(PROBE);
    // Served in the first test and cached since, so this costs no request.
    const without = await keyless.lookup(PROBE);

    // Without this the comparison is vacuous: a key the client quietly drops
    // produces a second keyless answer, which is a superset of itself.
    assert.ok(carriedTheKey, 'the key never reached the wire');
    assertTierIndependentShape(withKey);
    assert.equal(withKey.ip, without.ip);
    assert.equal(withKey.isVpn, without.isVpn, 'the base verdict cannot depend on the key');

    const keyedFields = Object.keys(withKey.raw);
    const keylessFields = Object.keys(without.raw);
    for (const field of keylessFields) {
        assert.ok(keyedFields.includes(field), `${field} is served keyless but not with the key`);
    }
    assert.ok(
        keyedFields.length >= keylessFields.length,
        `keyed answered ${keyedFields.length} fields, keyless ${keylessFields.length}`,
    );
});

function sends(input, key) {
    if (typeof input === 'string') {
        return input.includes(key);
    }
    return input.url.includes(key) || [...input.headers.values()].some((v) => v.includes(key));
}

// Holds on every plan: presence is the plan, the value is the answer.
function assertTierIndependentShape(r) {
    assert.equal(typeof r.ip, 'string');
    assert.equal(typeof r.isVpn, 'boolean', 'is_vpn is on every plan');

    for (const flag of FLAGS) {
        if (!(flag in r)) {
            assert.equal(r[flag], undefined, `${flag} is absent, so it must not read as anything`);
            continue;
        }
        assert.equal(typeof r[flag], 'boolean', `${flag} is present, so it must be a real boolean`);
    }

    for (const [name, spec] of Object.entries(DETAILS)) {
        if (!(name in r)) {
            continue;
        }
        const detail = r[name];
        assert.equal(typeof detail, 'object', `${name} must be an object when present`);
        const keys = Object.keys(detail);
        if (keys.length === 0) {
            const flag = `is${name[0].toUpperCase()}${name.slice(1)}`;
            if (flag in r) {
                assert.equal(r[flag], false, `${name} is empty, so ${flag} must be false`);
            }
            continue;
        }
        for (const key of spec.required) {
            assert.ok(key in detail, `${name} is populated but carries no ${key}`);
        }
        for (const key of keys) {
            const known = spec.required.includes(key) || spec.optional.includes(key);
            assert.ok(known, `${name}.${key} is not a documented key of this detail object`);
        }
    }
}
