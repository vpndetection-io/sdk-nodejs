# Changelog

What each release changed for you, newest first. Each line is a commit's summary, linked to its full description and diff. Releases before 5.2.2 are described by their release commits.

## 5.14.0 - 2026-11-14

### Features

- Re-pin the spec to 2026.11.14: is_bogon on every answer, and provider_name beside each provider ([`c91414f`](https://github.com/vpndetection-io/sdk-nodejs/commit/c91414feb9caf7a8d92eb49a20557c0625a85958))

### Fixes

- Re-pin the spec to 2026.11.12: plainer words on the 401 and the batch rate limit ([`d4bf17e`](https://github.com/vpndetection-io/sdk-nodejs/commit/d4bf17ee4f4c6fc3bbddce2c004b456dae46f50a))
- Say that a batch request of one address is answered as its lookup ([`43a7eef`](https://github.com/vpndetection-io/sdk-nodejs/commit/43a7eef4fdd6eeeaa2ac7cdfb507fc1ba8607c00))

## 5.13.2 - 2026-11-11

### Fixes

- Say Unlimited, the free plan, never the Unlimited tier, and re-pin the spec ([`bd19c0b`](https://github.com/vpndetection-io/sdk-nodejs/commit/bd19c0b8b3e088610fbe9b48ce07c429a1010ede))

## 5.13.1 - 2026-11-11

### Fixes

- Say the free plan's daily trial, never a trial key, and re-pin the spec ([`b6aba91`](https://github.com/vpndetection-io/sdk-nodejs/commit/b6aba911122ab8e6a856775fa9b4123cc034d04c))

## 5.13.0 - 2026-11-11

### Features

- Add trialExpired for a trial key's answers, and re-pin the spec ([`ec8d43c`](https://github.com/vpndetection-io/sdk-nodejs/commit/ec8d43c27232b9c194dfedea52fe3aabff0702ff))

## 5.12.2 - 2026-11-11

### Fixes

- Name the Unlimited tier and its terms, and re-pin the spec ([`4d00bc4`](https://github.com/vpndetection-io/sdk-nodejs/commit/4d00bc40be120a05d387415814caf0aa1e94c615))

## 5.12.1 - 2026-11-11

### Fixes

- Re-pin the spec's 2026.11.11 rebuild: plainer words on lookups without a key ([`289b939`](https://github.com/vpndetection-io/sdk-nodejs/commit/289b9395102f78410383881aa29405e8cefc122f))

## 5.12.0 - 2026-11-11

### Features

- Re-pin the spec to 2026.11.11: a lookup without a key answers more ([`947d970`](https://github.com/vpndetection-io/sdk-nodejs/commit/947d970e8e7069b66360ac06562ac85d6faa05c1))

## 5.11.0 - 2026-11-07

### Features

- Download the build a database.updated webhook names ([`6c05447`](https://github.com/vpndetection-io/sdk-nodejs/commit/6c0544770785b665ab9d41954bde367ec308b0cf))

## 5.10.4 - 2026-11-07

### Fixes

- Refuse a client concurrency that is not a whole number from 1 ([`a23907e`](https://github.com/vpndetection-io/sdk-nodejs/commit/a23907ee346f5c0f4b2586947253c2855366a74a))

## 5.10.3 - 2026-11-04

### Fixes

- Send no poll at the deadline, and none back to back without an expiry ([`ddaeb72`](https://github.com/vpndetection-io/sdk-nodejs/commit/ddaeb7272ea7f98c11036af4e8c795ccb86f14bb))

## 5.10.2 - 2026-10-26

### Fixes

- Re-pin the spec to 2026.10.25: Retry-After on myip's 429 ([`fee63ab`](https://github.com/vpndetection-io/sdk-nodejs/commit/fee63ab77e04c91a6dd984e488dbc5b85b8537f1))
- Refuse a date that is not RFC 3339 ([`960f1b6`](https://github.com/vpndetection-io/sdk-nodejs/commit/960f1b6cca92ec9ae66de400220f8b54f2438c15))

## 5.10.1 - 2026-10-23

### Fixes

- Check every member of every answer by its type, at any depth ([`d7001be`](https://github.com/vpndetection-io/sdk-nodejs/commit/d7001beea4e43e805389cc804b0067353252bc8d))
- Refuse an OAuth integer member that is not a whole number ([`1fc4e93`](https://github.com/vpndetection-io/sdk-nodejs/commit/1fc4e93a3d259e5f477870484a6e593f232aefd7))
- Refuse a key past U+00FF and a bad retry count where they are set ([`847865c`](https://github.com/vpndetection-io/sdk-nodejs/commit/847865c1633da5eb477ea166d62f36353442e586))

## 5.10.0 - 2026-10-20

### Features

- Add location and asn to lookup results, a bogon's included ([`5c2bcea`](https://github.com/vpndetection-io/sdk-nodejs/commit/5c2bcea984dc67360714ed82e07015acce3955f7))
- Read open on databases and downloads, and mark vpn.method deprecated ([`ea03041`](https://github.com/vpndetection-io/sdk-nodejs/commit/ea03041de375025d2f1af0983bad37107f031c76))

## 5.9.0 - 2026-10-20

### Features

- Add oauth.register, for RFC 7591 dynamic client registration ([`9440246`](https://github.com/vpndetection-io/sdk-nodejs/commit/9440246a543d09e20ae70ba4c5da0f27f2af6ec3))

### Fixes

- Report an OAuth answer that is not JSON as a server_error with its status ([`432ddc3`](https://github.com/vpndetection-io/sdk-nodejs/commit/432ddc34c1a80873d47afe03f00c4a1193df7e25))

## 5.8.1 - 2026-10-20

### Fixes

- Read a batch entry by the answer's own keys alone ([`c6bd29c`](https://github.com/vpndetection-io/sdk-nodejs/commit/c6bd29c1de7620aea08ba581426365dceb9ccb28))

## 5.8.0 - 2026-10-19

### Features

- Re-pin the spec to 2026.10.19: num_ports and num_proxies in the pubproxy detail ([`7dc2b7a`](https://github.com/vpndetection-io/sdk-nodejs/commit/7dc2b7afdb89733c9d8e712c6f07e60b56d607a4))

## 5.7.0 - 2026-10-18

### Features

- Re-pin the spec to 2026.10.18: isPubproxy and the pubproxy detail ([`feb59df`](https://github.com/vpndetection-io/sdk-nodejs/commit/feb59df7b279b2440daa1565661b611fa9a9655b))

## 5.6.0 - 2026-10-17

### Features

- Re-pin the spec to 2026.10.16: dynamic client registration ([`6a35c65`](https://github.com/vpndetection-io/sdk-nodejs/commit/6a35c65f9074f9e86d5f43677bc2ac17b26bdcd2))

## 5.5.3 - 2026-10-16

### Fixes

- Re-pin the spec to 2026.10.15: descriptions in US spelling ([`4ea8d08`](https://github.com/vpndetection-io/sdk-nodejs/commit/4ea8d08890dd82460f87e56b897ba909a3e721cc))

## 5.5.2 - 2026-10-12

### Fixes

- Read a Retry-After as seconds or an HTTP date, and nothing else ([`114f095`](https://github.com/vpndetection-io/sdk-nodejs/commit/114f09506ee53c7ab6176d4f10a92aebd53c2c3f))
- Retry a 2xx a call cannot read, as a server_error with its status ([`600ea45`](https://github.com/vpndetection-io/sdk-nodejs/commit/600ea4534c0c70f562572205d1316a6854e0df96))
- Send the API key trimmed, none for blanks, and refuse a control character ([`84b1189`](https://github.com/vpndetection-io/sdk-nodejs/commit/84b118934b49398b83070e615189ac8f3e129742))

## 5.5.1 - 2026-10-10

### Fixes

- Re-pin the spec to 2026.10.09: rotating a key needs apikeys.reveal ([`45b34cf`](https://github.com/vpndetection-io/sdk-nodejs/commit/45b34cff54c9c1be60a0b0f6432845c99fac9223))

## 5.5.0 - 2026-10-10

### Features

- Build for an Edge runtime: import no Node.js builtin ([`3030261`](https://github.com/vpndetection-io/sdk-nodejs/commit/3030261113476be82f208b26a27b3a7ec6a5a557))

### Fixes

- Wait out no Retry-After when no retry follows ([`c89ef62`](https://github.com/vpndetection-io/sdk-nodejs/commit/c89ef622af35f90ad5138db789e820296c698880))

## 5.4.0 - 2026-10-05

### Features

- Add the authorization code sign-in, with PKCE ([`1204380`](https://github.com/vpndetection-io/sdk-nodejs/commit/1204380bd4bb2229a6bb119102315ec6376d99a3))

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
