# [<img src="https://s3.vpndetection.io/vpndetection-public/brand/mark.svg" alt="VPNDetection" height="28"/>](https://vpndetection.io/) VPNDetection Node.js Client Library

[![npm](https://img.shields.io/npm/v/vpndetection.svg)](https://www.npmjs.com/package/vpndetection)
[![license](https://img.shields.io/npm/l/vpndetection.svg)](LICENSE)

The official Node.js client library for the [VPNDetection](https://vpndetection.io) API.

The library helps you query VPNDetection's APIs for anonymity detection including VPNs, residential proxies, Tor nodes, hosting servers, CDNs, relays and more.

## Getting Started

```bash
npm install vpndetection
```

Requires Node.js 22 or newer. TypeScript types are included.

## Usage

**No API key needed to start.** The free tier answers `ip` and `is_vpn`, and allows 1000 requests per day per source address.

```js
import { VPNDetection } from 'vpndetection';

const client = new VPNDetection();

const result = await client.lookup('45.83.91.1');
console.log(result.isVpn);   // true
```

### With an API key

An API key raises your quota, and raises your features on a paid plan. Create one in the [console](https://app.vpndetection.io), then pass it in:

```js
const client = new VPNDetection({ apiKey: process.env.VPNDETECTION_API_KEY });

const result = await client.lookup('45.83.91.1');
console.log(result.isVpn);          // true
console.log(result.vpn?.provider);  // 'mullvad'
console.log(result.isHosting);      // true
console.log(result.hosting?.provider);
```

### Your own address

```js
const result = await client.myIp();
console.log(result.ip);   // the address we saw this call come from
```

### Your plan and usage

```js
const ent = await client.myEntitlement();
console.log(ent.plan.key);          // max
console.log(ent.usage.requests);    // 580
console.log(ent.usage.window_end);  // when the allowance resets
```

Usage counts against the anniversary of your subscription, not the calendar month and not the billing period, and it is the same number a lookup is gated on. `hard_limit` is null on an uncapped plan, which is not the same as zero.

### Batch lookup

Look up as many addresses as you like in one call. Bogons and cached answers are handled locally, and the rest go to the batch endpoint in chunks of up to 1000, in parallel:

```js
const results = await client.lookupBatch(['45.83.91.1', '8.8.8.8', '1.1.1.1']);

for (const [ip, result] of results) {
    if (result instanceof Error) {
        console.log(`${ip}: ${result.message}`);
        continue;
    }
    console.log(`${ip}: ${result.isVpn}`);
}
```

Results are keyed by address, in the order you first listed each one, so duplicates in your list collapse into a single entry and one address failing never loses the rest: it carries its error as its value, with the status the API would have given that address on its own.

How many chunks are in flight at once, how many times a failed chunk is retried, and how long each request may take are configurable per call:

```js
const results = await client.lookupBatch(manyIps, { concurrency: 4, retries: 4, timeoutMs: 10_000 });
```

### Caching

Answers are cached by default, so repeat lookups of the same address are free:

```js
const client = new VPNDetection();

const result = await client.lookup('45.83.91.1');
console.log(result.isVpn);   // true, API request

const result2 = await client.lookup('45.83.91.1');
console.log(result2.isVpn);  // true, no API request, result was cached
```

You can change the default cache variables (max size, TTL, etc) on initialization, or even disable it:

```js
const client = new VPNDetection({ cache: { max: 50_000, ttlMs: 6 * 60 * 60 * 1000 } });
const clientNoCache = new VPNDetection({ cache: false });
```

### Private and reserved addresses

Private, loopback, link-local, documentation and multicast addresses (and their IPv6 equivalents, including the 6to4 and Teredo ranges) can never be VPN or proxy infrastructure. The library answers them locally, so they cost no request and no quota:

```js
const result = await client.lookup('192.168.1.1');
result.isBogon;   // true, this answer was computed rather than served
result.isVpn;     // false
```

The check is available on the client, which is handy when your inputs are addresses anyway:

```js
client.isBogon('10.0.0.1');    // true
client.isBogon('8.8.8.8');     // false
```

It is also importable on its own, if you want it without a client:

```js
import { isBogon } from 'vpndetection';

isBogon('10.0.0.1');    // true
```

### Errors

Failures throw a `VPNDetectionError` carrying a `kind` and a `retryable` flag:

```js
import { VPNDetectionError } from 'vpndetection';

try {
    await client.lookup('1.1.1.1');
} catch (err) {
    if (err instanceof VPNDetectionError) {
        console.error(err.kind, err.retryable);
    }
}
```

`kind` is one of `bad_request`, `unauthorized`, `forbidden`, `rate_limited`, `quota_exceeded`, `server_error` or `network`.

Note that `rate_limited` and `quota_exceeded` both arrive as HTTP 429 and are not the same thing. A rate limit is when the API faces extreme traffic bursts and so retrying later works; but a spent quota needs your allowance raised or the window to roll over. The library retries rate limits for you, but not if your quota is exceeded.

### Timeouts

A request that hasn't finished after 30 seconds is abandoned and surfaces as a retryable `network` error. The limit applies to each attempt, so a call that gets retried can take longer in total. Set it for the client, or for a single lookup:

```js
const client = new VPNDetection({ timeoutMs: 10_000 });

const result = await client.lookup('45.83.91.1', { timeoutMs: 2000 });
```

A database transfer is exempt, because a large one takes minutes.

### Database downloads

If your key carries the `db.download` scope, the licensed databases are available through `client.database`. `download` fetches one to a path, streaming it straight to disk so that nothing bigger than a chunk is ever held in memory:

```js
const databases = await client.database.list();

const written = await client.database.download('vpn_ip_extended_v1', 'mmdb', './vpn_ip_extended_v1.mmdb');
console.log(`${written} bytes`);
```

Or take the time-limited link and run the transfer yourself, or take a small database as bytes:

```js
const url = await client.database.downloadUrl('vpn_ip_extended_v1', 'mmdb');
const bytes = await client.database.downloadBytes('cdn_ip_v1', 'csvgz');
```

`downloadBytes` holds the whole file in memory, and the catalog runs from `cdn_ip_v1` at 10 KB to `resproxy_ip_90d_v1` at 1.79 GB, so use `download` for anything you have not measured.

The formats are `csvgz` and `mmdb`, exported as `DATABASE_FORMATS` for a caller that needs to validate or enumerate rather than switch — `STANDINGS` and `LICENSE_TYPES` likewise. Anything else is refused before the request leaves, as a `bad_request` naming what is allowed, because the TypeScript union only guards a TypeScript caller:

```js
import { DATABASE_FORMATS } from 'vpndetection';

DATABASE_FORMATS.includes(fromTheCommandLine);  // ['csvgz', 'mmdb']
```

### Sign in with OAuth (device flow)

A program running on the person's own machine can let them sign in with a browser and pick one of their API keys, instead of asking them to paste it:

```js
const client = new VPNDetection();

const device = await client.oauth.deviceAuthorization('your-client-id', {
    scope: 'account.read apikeys.read apikeys.reveal',
});
console.log(`Open ${device.verification_uri} and enter ${device.user_code}`);

const token = await client.oauth.pollDeviceToken('your-client-id', device);
if (token.apikey === undefined) {
    throw new Error("no API key came back: none was picked, or it can't be shown again");
}
const keyed = new VPNDetection({ apiKey: token.apikey });
```

A denied sign-in rejects with `OauthAccessDeniedError` and a code that ran out with `OauthExpiredTokenError`. Client IDs are issued on request from support@vpndetection.io, and `client.oauth.revoke('your-client-id', token.refresh_token)` signs the machine out again.

### Absent is not false

Only `ip` and `isVpn` come back on every plan. A field your plan does not include is `undefined`, which means "not in your plan" rather than "checked, and no".

```js
result.isHosting ?? false        // when you only want the flag
result.isHosting === undefined   // not in your plan
```

## Other Libraries

There are official VPNDetection client libraries available for many languages including PHP, Python, Go, Java, Ruby, and many popular frameworks such as Django, Rails, and Laravel. See our GitHub at https://github.com/vpndetection-io for more.

## About VPNDetection

VPN Detection API: Accurate anonymity detection identifying VPNs, residential proxies, hosting servers, Tor nodes, CDNs, relays and more.

[<img src="https://s3.vpndetection.io/vpndetection-public/brand/mark.svg" alt="VPNDetection" height="64"/>](https://vpndetection.io/)

## License

This project is licensed under the [MIT License](LICENSE).
