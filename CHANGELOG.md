# Changelog

What each release changed for you, newest first. Each line is a commit's summary, linked to its full description and diff. Releases before 5.2.2 are described by their release commits.

## 5.3.4 - 2026-10-04

### Fixes

- Re-pin the spec to 2026.10.03: metadata needs no license ([`259f035`](https://github.com/vpndetection-io/sdk-nodejs/commit/259f0359360f2c9c3b82f0bad0f71378cebc2c9a))

## 5.3.3 - 2026-09-29

### Fixes

- Recognize 26 more reserved ranges as bogons, as the API does ([`5e3139a`](https://github.com/vpndetection-io/sdk-nodejs/commit/5e3139a6e6bfca2737f65ff876f412da13ab4a11))

## 5.3.2 - 2026-09-28

### Fixes

- Wait a Retry-After past setTimeout's ceiling on the backoff, with no warning ([`da08790`](https://github.com/vpndetection-io/sdk-nodejs/commit/da08790c0fef5d49c84731e2f22c1f85ba0f6979))
- Judge an IPv4-mapped address as the IPv4 address it carries ([`fd611f3`](https://github.com/vpndetection-io/sdk-nodejs/commit/fd611f3432455ca2346e39352889f3e3908037d3))

## 5.3.1 - 2026-09-27

### Fixes

- Drop every trailing slash, and refuse a timeout no attempt can meet ([`121fa4b`](https://github.com/vpndetection-io/sdk-nodejs/commit/121fa4bb74fc5adab019509ac983ededf183dfb7))
- End the poll's sleep at its deadline, and sleep past setTimeout's ceiling ([`c7690bf`](https://github.com/vpndetection-io/sdk-nodejs/commit/c7690bf1ad8ef32c77fe8d8eb2c4334c80d6635c))

## 5.3.0 - 2026-09-27

### Features

- Re-pin the spec to 2026.09.26, adding client_id_metadata_document_supported ([`7686f88`](https://github.com/vpndetection-io/sdk-nodejs/commit/7686f889ba550e653c69bbbcf9ef4a47f1dda245))

## 5.2.2 - 2026-09-25

### Fixes

- Share one request per address between concurrent misses ([`a467bf1`](https://github.com/vpndetection-io/sdk-nodejs/commit/a467bf1810fb83c9e601ab6f855ebff3bd40cfe9))
