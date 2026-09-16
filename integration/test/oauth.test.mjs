// The OAuth accessor against staging, on a client built with NO key, since none
// of these requests needs one. Only what is safe to repeat runs here: polling
// needs a person to approve the sign-in, so it never does.

import assert from 'node:assert/strict';
import { test } from 'node:test';

// A namespace import, because a named import of a class the installed version
// lacks fails the whole file at link time instead of skipping.
import * as vpndetection from 'vpndetection';

import { STAGING, needsVersion } from '../lib/staging.mjs';

const NOT_YET = needsVersion('5.2.0', 'the oauth accessor');

// The only client ID the server accepts, already public in the CLI's source.
const CLIENT_ID = 'vpndetection-cli';

function keyless() {
    return new vpndetection.VPNDetection({ baseUrl: STAGING });
}

test('metadata names staging as the issuer', { skip: NOT_YET }, async () => {
    const metadata = await keyless().oauth.metadata();

    assert.equal(metadata.issuer, STAGING);
    assert.ok(metadata.device_authorization_endpoint, 'no device_authorization_endpoint');
    assert.ok(metadata.code_challenge_methods_supported?.includes('S256'), 'S256 is not offered');
});

// Answers 200 for any token, known or not, and is not rate limited.
test('revoke accepts a token that was never issued', { skip: NOT_YET }, async () => {
    await keyless().oauth.revoke(CLIENT_ID, 'mo_rt_sdk-ci-not-a-token');
});

// An unknown code answers expired_token before anything is recorded.
test('an unknown device code is the expired-token refusal', { skip: NOT_YET }, async () => {
    await assert.rejects(keyless().oauth.exchangeDeviceCode(CLIENT_ID, 'mo_dc_sdk-ci-not-a-code'), (err) => {
        assert.ok(err instanceof vpndetection.OauthExpiredTokenError, `${err.name}: ${err.message}`);
        assert.equal(err.status, 400);
        return true;
    });
});

// ONE per run: the server allows 30 a minute per source address, and runners
// share addresses, so a slow_down refusal passes. Never polled: nobody approves
// it, and it expires by itself.
test('device authorization starts a sign-in', { skip: NOT_YET }, async (t) => {
    let device;
    try {
        device = await keyless().oauth.deviceAuthorization(CLIENT_ID, { scope: 'account.read' });
    } catch (err) {
        if (err instanceof vpndetection.OauthError && err.errorCode === 'slow_down') {
            t.diagnostic(`refused with slow_down, which passes: ${err.message}`);
            return;
        }
        throw err;
    }
    assert.ok(device.device_code.length > 0, 'empty device_code');
    assert.ok(device.user_code.length > 0, 'empty user_code');
    assert.ok(device.verification_uri.endsWith('/device'), device.verification_uri);
    assert.ok(device.expires_in > 0, 'expires_in is not positive');
    assert.ok(device.interval > 0, 'interval is not positive');
});
