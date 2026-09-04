// The published package looking addresses up against the staging API.
//
// Nothing here pins a field COUNT. The tiers are asserted as a RELATION -
// each one serves a superset of the tier below it - so a pricing change stays a
// pricing change instead of arriving as a red SDK build. What a served answer
// must satisfy on every tier: `ip` and `is_vpn` always; a present flag is a real
// boolean; a field a higher tier serves is ABSENT on a lower one rather than
// false; a populated detail object carries its documented keys; an empty one
// means its flag is false.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VPNDetection, isBogon } from 'vpndetection';

import {
    INSTALLED_VERSION, MEMBERS, PROBE, RESULT_PROP, STAGING, answerFor, assertServedByTier,
    assertShape, clientFor, flagProp,
} from '../lib/staging.mjs';
import { RUNGS, UNAUTH_RUNG, observableRungs, skipFor } from '../lib/tiers.mjs';

// The ladder needs two rungs to say anything. The unauthenticated one is always
// there, so this only fires when no tier secret at all is configured.
const LADDER = observableRungs().length > 1
    ? false
    : 'no tier secret is set, so there is no ladder to compare';

test('an unauthenticated lookup answers ip and is_vpn', async () => {
    const fixture = await answerFor(UNAUTH_RUNG);

    assert.equal(fixture.result.raw.ip, PROBE);
    assert.equal(typeof fixture.result.raw.is_vpn, 'boolean');
    assert.equal(typeof fixture.result.isVpn, 'boolean');
    assertServedByTier(fixture);
    console.log(`testing vpndetection@${INSTALLED_VERSION} against ${STAGING}`);
});

for (const rung of RUNGS.filter((r) => r.secret !== null)) {
    test(`a ${rung.tier} key reaches the wire and its answer keeps the shape`,
        { skip: skipFor(rung) }, async () => {
            assertServedByTier(await answerFor(rung));
        });
}

test('each tier serves a superset of the tier below', { skip: LADDER }, async () => {
    let below = null;
    for (const rung of observableRungs()) {
        const fixture = await answerFor(rung);
        const fields = new Set(Object.keys(fixture.result.raw));
        console.log(`${rung.tier}: ${fields.size} fields`);
        if (below !== null) {
            for (const field of below.fields) {
                assert.ok(fields.has(field), `${rung.tier} drops ${field}, which ${below.tier} serves`);
            }
            // Without this a suite in which every key resolved to the same plan
            // would pass: identical sets satisfy containment in both directions.
            if (rung.widens) {
                assert.ok(
                    fields.size > below.fields.size,
                    `${rung.tier} answers no more fields than ${below.tier}`,
                );
            }
        }
        below = { tier: rung.tier, fields: fields };
    }
});

test('a field a higher tier serves is absent on a lower one, never false', { skip: LADDER }, async () => {
    const fixtures = [];
    for (const rung of observableRungs()) {
        fixtures.push(await answerFor(rung));
    }

    for (const { rung, result } of fixtures) {
        // The mapper copies on key PRESENCE, not on truthiness, so a plan that
        // includes a flag and answers `false` must keep it.
        for (const field of Object.keys(result.raw)) {
            const prop = RESULT_PROP[field];
            if (prop !== undefined) {
                assert.ok(prop in result, `${rung.tier} serves ${field} and the client dropped it`);
            }
        }
    }

    for (let i = 0; i < fixtures.length - 1; i++) {
        const lower = fixtures[i];
        const higher = new Set(fixtures.slice(i + 1).flatMap((f) => Object.keys(f.result.raw)));
        for (const field of higher) {
            const prop = RESULT_PROP[field];
            if (field in lower.result.raw || prop === undefined) {
                continue;
            }
            assert.ok(
                !(prop in lower.result),
                `${field} is not in the ${lower.rung.tier} plan, so ${prop} must not exist on the result`,
            );
            assert.equal(
                lower.result[prop], undefined,
                `${field} is not in the ${lower.rung.tier} plan, so ${prop} must not read as anything`,
            );
        }
    }
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
    for (const name of Object.keys(MEMBERS)) {
        assert.equal(r[flagProp(name)], false, `${flagProp(name)} must be present and false on a bogon`);
        assert.deepEqual(r[name], {}, `${name} must be present and empty on a bogon`);
    }
});

test('a batch collapses duplicates and keeps bogons off the wire', async () => {
    // Distinct paths rather than a call count, so a retry against a wobbling
    // staging cannot read as a failure to deduplicate.
    const asked = new Set();
    const counting = clientFor(UNAUTH_RUNG, (fact) => asked.add(fact.path));

    const got = await counting.lookupBatch([PROBE, '8.8.8.8', PROBE, '10.0.0.1', '8.8.8.8']);

    assert.deepEqual([...got.keys()], [PROBE, '8.8.8.8', '10.0.0.1']);
    assert.deepEqual([...asked].sort(), [`/${PROBE}`, '/8.8.8.8'].sort());
    assert.equal(got.get('10.0.0.1').isBogon, true);
    for (const ip of [PROBE, '8.8.8.8']) {
        assert.ok(!(got.get(ip) instanceof Error), `${ip} failed`);
        assertShape(got.get(ip));
    }
});
