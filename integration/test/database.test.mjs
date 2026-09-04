// The licensed-download half, which only the max key can reach: it is the tier
// holding dataset licences, and `db.download` is a scope the other three keys
// do not carry.
//
// The transfer is budgeted before it starts. `metadata` publishes a size per
// format, and that size is checked against the ceiling below FIRST, so a
// mistaken dataset id can never quietly pull one of the gigabyte datasets
// through CI.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { VPNDetectionError } from 'vpndetection';

import { STAGING_ORIGIN, clientFor, needsVersion } from '../lib/staging.mjs';
import { MAX_RUNG, skipFor } from '../lib/tiers.mjs';

const NO_KEY = skipFor(MAX_RUNG);
// This suite installs what the REGISTRY offers, which lags the working tree
// between releases. `download`, `downloadBytes` and `checksums` land in 1.2.0,
// so against an older published version they skip with the version named rather
// than failing as a missing method.
const NO_TRANSFER = NO_KEY || needsVersion('1.2.0', 'download, downloadBytes and checksums');

// The max organization licenses `cdn_ip` for redistribution, and at ~10 KB it is
// the only dataset small enough to move in CI. Named rather than discovered:
// `list` is the one endpoint whose payload does not match the schema this client
// was generated from, so nothing here may be derived from it.
const DATASET_ID = 'cdn_ip_v1';
const FORMAT = 'csvgz';
// 8 MiB against a ~10 KB dataset. Three orders of magnitude of headroom, so
// tripping it means the suite is pointed somewhere unintended, which is exactly
// when a transfer must not go ahead.
const CEILING = 8 * 1024 * 1024;
// A real catalogue id the max organization holds no licence for.
const UNLICENSED_ID = 'hosting_ip_v1';

const facts = [];
const tmp = mkdtempSync(join(tmpdir(), 'vpndetection-integration-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let client = null;
let transfer = null;

test('the licensed catalogue answers the schema the client was generated from', { skip: NO_KEY },
    async () => {
        const datasets = await maxClient().database.list();

        assert.ok(datasets.length > 0, 'the max organization licenses nothing');
        // Named first, and with what actually arrived, because every assertion
        // below reads as `undefined` when the payload disagrees, and a bare
        // "expected string" costs a whole CI cycle to interpret.
        const served = [...new Set(datasets.flatMap((d) => Object.keys(d)))].sort();
        assert.ok(
            served.includes('base') && served.includes('versions'),
            `the payload carries ${served.join(', ')}, and LicensedDataset declares base and versions`,
        );
        assert.ok(
            !served.includes('docsGroup'),
            'docsGroup is a docs-site slug and must not be published as API surface',
        );
        for (const d of datasets) {
            assert.equal(typeof d.base, 'string');
            assert.equal(typeof d.name, 'string');
            assert.equal(typeof d.in_term, 'boolean');
            assert.ok(['expired', 'licensed', 'unlicensed'].includes(d.standing),
                `${d.base} carries an undocumented standing`);
            const rights = ['evaluation', 'internal', 'redistribute'];
            assert.ok(rights.includes(d.redistribution), `${d.base} carries an undocumented right`);
            // The point of the family shape: a license covers the family, and
            // these are the ids the download and checksum methods take. Before
            // the spec was corrected this list did not exist, so list() could
            // not tell a caller what to download.
            assert.ok(Array.isArray(d.versions) && d.versions.length > 0,
                `${d.base} carries no versions`);
            for (const v of d.versions) {
                assert.equal(typeof v.id, 'string', `${d.base} has a version with no id`);
                assert.ok(Array.isArray(v.formats), `${v.id} carries no formats`);
            }
        }
        console.log(`licensed: ${datasets.flatMap((d) => d.versions.map((v) => v.id)).join(', ')}`);
    });

test('a dataset the organization does not license is refused cleanly', { skip: NO_KEY }, async () => {
    const before = facts.length;

    await assert.rejects(maxClient().database.downloadUrl(UNLICENSED_ID, FORMAT), (err) => {
        assert.ok(err instanceof VPNDetectionError, 'a refusal must arrive as the library error type');
        assert.equal(err.kind, 'forbidden');
        assert.equal(err.status, 403);
        assert.equal(err.retryable, false, 'a licence refusal is not worth retrying');
        // The API says which refusal this is (`{"rc":"NOT_LICENSED"}`). Falling
        // back to the status means the client never read the envelope.
        assert.ok(err.message.length > 0, 'the refusal carries no message');
        assert.ok(
            !err.message.startsWith('request failed with status'),
            'the message is the client fallback, so the response body went unread',
        );
        return true;
    }, `${UNLICENSED_ID} is now licensed to this organization, so point this at one that is not`);

    assert.equal(facts.length - before, 1, 'a 4xx must not be retried');
});

test('download streams a real dataset to disk intact', { skip: NO_TRANSFER }, async () => {
    const dl = await downloaded();

    assert.ok(dl.bytes > 0, 'nothing was transferred');
    assert.equal(statSync(dl.path).size, dl.bytes, 'the file is not the length the method reported');
    assert.equal(existsSync(`${dl.path}.part`), false, 'the .part file outlived a successful transfer');
    assert.deepEqual([...readFileSync(dl.path).subarray(0, 2)], [0x1f, 0x8b], 'the payload is not gzip');

    assert.equal(typeof dl.checksums.sha256, 'string', 'checksums must unwrap past the envelope');
    assert.match(dl.checksums.sha256, /^[0-9a-f]{64}$/);
    assert.equal(sha256(readFileSync(dl.path)), dl.checksums.sha256, 'the bytes are not the published file');

    // The presigned URL authorizes itself, so the second request must carry no
    // credential: `fetch` keeps a custom header across a cross-origin redirect.
    const storage = facts.filter((fact) => fact.origin !== STAGING_ORIGIN);
    assert.ok(storage.length > 0, 'nothing was fetched from object storage, so no 302 was followed');
    for (const fact of storage) {
        assert.equal(fact.carriedKey, false, 'the API key was sent to object storage');
    }
});

test('downloadBytes agrees with the streamed copy', { skip: NO_TRANSFER }, async () => {
    const dl = await downloaded();

    const bytes = await maxClient().database.downloadBytes(DATASET_ID, FORMAT);

    assert.equal(bytes.length, dl.bytes, 'the in-memory copy is a different length');
    assert.equal(sha256(bytes), dl.checksums.sha256, 'the in-memory copy is not the published file');
});

function maxClient() {
    if (client === null) {
        client = clientFor(MAX_RUNG, (fact) => facts.push(fact));
    }
    return client;
}

// Memoized so the two transfer tests share one download rather than pulling the
// dataset twice each.
function downloaded() {
    if (transfer === null) {
        transfer = download();
    }
    return transfer;
}

async function download() {
    const meta = await maxClient().database.metadata(DATASET_ID);
    assert.equal(meta.id, DATASET_ID);
    const size = meta.size?.[FORMAT];
    assert.equal(typeof size, 'number', `${DATASET_ID} publishes no ${FORMAT} size to check against`);
    assert.ok(size > 0 && size <= CEILING, `${DATASET_ID} is ${size} bytes, past the ${CEILING} ceiling`);

    const path = join(tmp, `${DATASET_ID}.csv.gz`);
    const bytes = await maxClient().database.download(DATASET_ID, FORMAT, path);
    // Read after the transfer, so a rebuild between the two calls shows up as a
    // digest mismatch rather than passing against a digest of nothing.
    const checksums = await maxClient().database.checksums(DATASET_ID, FORMAT);
    console.log(`${DATASET_ID}.${FORMAT}: ${bytes} bytes, metadata says ${size}`);
    return { bytes: bytes, path: path, checksums: checksums };
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
