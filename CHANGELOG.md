# Changelog

What each release changed for you, newest first. Each line is a commit's summary, linked to its full description and diff. Releases before 5.2.2 are described by their release commits.

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
