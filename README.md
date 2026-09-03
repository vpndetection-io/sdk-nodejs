# [<img src="https://s3.vpndetection.io/vpndetection-public/brand/mark.svg" alt="VPNDetection" width="24"/>](https://vpndetection.io/) VPNDetection Node.js Client Library

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

Your plan decides which fields come back. `isVpn` is always present; every other flag is `undefined` when your plan does not include it, which is different from `false` (we checked, and no). Use `result.isHosting ?? false` if you only care whether the address is flagged.

### Batch lookup

You can do batch lookups with a list, which parallelizes requests for you efficiently:

```js
const results = await client.lookupBatch(['45.83.91.1', '8.8.8.8', '1.1.1.1']);

for (const [ip, result] of results) {
    if (result instanceof Error) {
        console.error(`${ip}: ${result.message}`);
        continue;
    }
    console.log(`${ip}: ${result.isVpn}`);
}
```

Results are keyed by address, so duplicates in your list collapse into a single request and one address failing never loses the rest.

Concurrency and other variables are configurable per-call:

```js
const results = await client.lookupBatch(manyIps, { concurrency: 32, retries: 4 });
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

### Database downloads

If your key carries the `db.download` scope, the licensed datasets are available through `client.database`:

```js
const datasets = await client.database.list();
const url = await client.database.downloadUrl('vpn_ip_extended_v1', 'mmdb');
```

`downloadUrl` returns a time-limited link rather than the bytes, so you choose how to transfer a file that can run to gigabytes.

## Other Libraries

There are official VPNDetection client libraries available for many languages including PHP, Python, Go, Java, Ruby, and many popular frameworks such as Django, Rails, and Laravel. See our GitHub at https://github.com/vpndetection-io for more.

## About VPNDetection

VPN Detection API: Accurate anonymity detection identifying VPNs, residential proxies, hosting servers, tor nodes, CDNs, relays and more.

[<img src="https://s3.vpndetection.io/vpndetection-public/brand/mark.svg" alt="VPNDetection" width="96"/>](https://vpndetection.io/)

## License

This project is licensed under the [MIT License](LICENSE).
