# [<img src="https://s3.vpndetection.io/vpndetection-public/brand/mark.svg" alt="VPNDetection" width="24"/>](https://vpndetection.io/) VPNDetection Node.js Client Library

[![npm](https://img.shields.io/npm/v/vpndetection.svg)](https://www.npmjs.com/package/vpndetection)
[![license](https://img.shields.io/npm/l/vpndetection.svg)](LICENSE)

The official Node.js client library for the [VPNDetection](https://vpndetection.io) API.

Ask it about an IP address and it tells you whether the address is a VPN, and
what else is known about it: hosting, relay, Tor, CDN, and the residential,
datacenter and mobile proxy pools.

## Getting Started

```bash
npm install vpndetection
```

Requires Node.js 20 or newer. TypeScript types are included.

## Usage

**No API key needed to start.** The free tier answers `ip` and `is_vpn`, and
allows 1000 requests per day per source address.

```js
import { VPNDetection } from 'vpndetection';

const client = new VPNDetection();

const result = await client.lookup('45.83.91.1');
console.log(result.isVpn);   // true
```

### With an API key

A key raises your daily allowance and widens the answer. Create one in the
[console](https://vpndetection.io), then pass it in once:

```js
const client = new VPNDetection({ apiKey: process.env.VPNDETECTION_API_KEY });

const result = await client.lookup('45.83.91.1');
console.log(result.isVpn);          // true
console.log(result.vpn?.provider);  // 'mullvad'
console.log(result.isHosting);      // true
console.log(result.hosting?.provider);
```

That is the only thing a key changes. Everything below works either way.

### Reading the result

Your plan decides which fields come back, and the library keeps that
distinction rather than flattening it:

- `result.isVpn` is on **every** plan, so it is always a boolean.
- Every other flag is `boolean | undefined`. **`undefined` means the field is
  not in your plan**, never "we checked and found nothing". `false` means we
  checked and the answer is no.
- A detail object that is present but empty (`{}`) means the flag above it is
  `false`. A populated one always carries all of its keys.

If you only care whether an address is flagged, coalesce:

```js
if (result.isHosting ?? false) {
    // ...
}
```

And if you want the response exactly as it came off the wire, it is on
`result.raw`.

### Looking up many addresses

Pass any iterable of addresses. Requests run concurrently, duplicates collapse
to a single call, and the result is keyed by address so you never have to line
two lists up:

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

One address failing never loses the others: that address's value is the error.
Concurrency defaults to 8 and is configurable.

### Caching

Answers are cached per client instance, so repeat lookups of the same address
are free. Defaults are 10,000 addresses and a one hour TTL:

```js
const client = new VPNDetection({ cache: { max: 50_000, ttlMs: 6 * 60 * 60 * 1000 } });
const noCache = new VPNDetection({ cache: false });
```

The cache is per instance, never global, so two clients holding different API
keys can never serve each other's answers.

### Private and reserved addresses

Private, loopback, link-local, documentation and multicast addresses (and their
IPv6 equivalents, including the 6to4 and Teredo ranges) can never be VPN or
proxy infrastructure. The library answers them locally, so they cost no request
and no quota:

```js
const result = await client.lookup('192.168.1.1');
result.isBogon;   // true, this answer was computed rather than served
result.isVpn;     // false
```

The check is exported on its own, which is handy when your inputs are addresses
anyway:

```js
import { isBogon } from 'vpndetection';

isBogon('10.0.0.1');    // true
isBogon('8.8.8.8');     // false
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

`kind` is one of `bad_request`, `unauthorized`, `forbidden`, `rate_limited`,
`quota_exceeded`, `server_error` or `network`.

Note that `rate_limited` and `quota_exceeded` both arrive as HTTP 429 and are
not the same thing. A rate limit is the API protecting itself and retrying
works; a spent quota needs your allowance raised or the window to roll over.
The library retries the former for you and never the latter.

### Database downloads

If your key carries the `db.download` scope, the licensed datasets are on
`client.database`:

```js
const datasets = await client.database.list();
const url = await client.database.downloadUrl('vpn_ip_extended_v1', 'mmdb');
```

`downloadUrl` returns a time-limited link rather than the bytes, so you choose
how to transfer a file that can run to gigabytes.

## Other Libraries

There are official VPNDetection client libraries available for many languages
including PHP, Python, Go, Java, Ruby, and many popular frameworks such as
Django, Rails, and Laravel. See our GitHub at
https://github.com/vpndetection-io for more.

## About VPNDetection

VPN Detection API: Accurate anonymity detection identifying all VPNs,
residential proxies, tor nodes, CDNs, relays and more.

[<img src="https://s3.vpndetection.io/vpndetection-public/brand/mark.svg" alt="VPNDetection" width="96"/>](https://vpndetection.io/)

## License

This project is licensed under the [MIT License](LICENSE).
