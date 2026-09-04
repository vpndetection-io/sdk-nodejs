// The licensed-download half, which only the max key can reach: it is the tier
// holding dataset licences, and `db.download` is a scope the other three keys
// do not carry.
//
// The transfer is budgeted before it starts. The catalogue advertises a size per
// format, so the ceiling below is checked against it FIRST: a mistaken dataset
// id can never quietly pull one of the gigabyte datasets through CI.

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

// The family the max organization licenses for redistribution, and the only one
// small enough to move in CI.
const DATASET = 'cdn_ip';
const FORMAT = 'csvgz';
// 8 MiB, against a dataset that is ~10 KB. The headroom is three orders of
// magnitude, so tripping this means the suite is pointed at the wrong dataset,
// which is exactly when a download must not go ahead.
const CEILING = 8 * 1024 * 1024;

// Real ids from the published catalogue that the max organization is not
// expected to license. The first one it does not hold is what the refusal test
// asks for, so licensing another dataset later does not break the test.
const UNLICENSED_CANDIDATES = [
    'hosting_ip_v1', 'hosting_provider_v1', 'vpn_ip_extended_v1', 'vpn_provider_v2',
    'cdn_provider_v1',
];

const facts = [];
const tmp = mkdtempSync(join(tmpdir(), 'vpndetection-integration-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let client = null;
let catalogue = null;
let transfer = null;

test('the max key lists the datasets its organization licenses', { skip: NO_KEY }, async () => {
    const datasets = await licensed();

    assert.ok(datasets.length > 0, 'the max organization licenses nothing');
    for (const d of datasets) {
        assert.equal(typeof d.id, 'string');
        assert.equal(typeof d.name, 'string');
        assert.equal(typeof d.in_term, 'boolean');
        assert.ok(Array.isArray(d.formats), `${d.id} carries no formats`);
        const rights = ['evaluation', 'internal', 'redistribute'];
        assert.ok(rights.includes(d.redistribution), `${d.id} carries an undocumented right`);
    }
    console.log(`licensed: ${datasets.map((d) => d.id).join(', ')}`);

    const chosen = pick(datasets);
    assert.ok(chosen !== undefined, `the max organization does not license ${DATASET}`);
    assert.equal(chosen.in_term, true, `the ${DATASET} licence is out of term`);
});

test('a dataset the organization does not license is refused cleanly', { skip: NO_KEY }, async (t) => {
    const held = new Set((await licensed()).map((d) => d.id));
    const target = UNLICENSED_CANDIDATES.find((id) => !held.has(id));
    if (target === undefined) {
        t.skip('the max organization now licenses every candidate, so nothing here is refused');
        return;
    }

    const before = facts.length;
    await assert.rejects(maxClient().database.downloadUrl(target, FORMAT), (err) => {
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
    });

    assert.equal(facts.length - before, 1, 'a 4xx must not be retried');
});

test('download streams a real dataset to disk intact', { skip: NO_TRANSFER }, async () => {
    const dl = await downloaded();

    assert.equal(dl.bytes, dl.size, 'the transfer is not the size the catalogue advertises');
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

    const bytes = await maxClient().database.downloadBytes(dl.id, FORMAT);

    assert.equal(bytes.length, dl.bytes, 'the in-memory copy is a different length');
    assert.equal(sha256(bytes), dl.checksums.sha256, 'the in-memory copy is not the published file');
});

function maxClient() {
    if (client === null) {
        client = clientFor(MAX_RUNG, (fact) => facts.push(fact));
    }
    return client;
}

// Memoized so the whole file costs one list call, and so the two transfer tests
// share a single download rather than fetching the dataset twice each.
function licensed() {
    if (catalogue === null) {
        catalogue = maxClient().database.list();
    }
    return catalogue;
}

function downloaded() {
    if (transfer === null) {
        transfer = download();
    }
    return transfer;
}

async function download() {
    const chosen = pick(await licensed());
    const size = chosen?.formats.find((f) => f.format === FORMAT)?.bytes;
    assert.equal(typeof size, 'number', `${DATASET} is not published as ${FORMAT}`);
    assert.ok(size > 0 && size <= CEILING, `${chosen.id} is ${size} bytes, past the ${CEILING} byte ceiling`);

    const path = join(tmp, `${chosen.id}.csv.gz`);
    const bytes = await maxClient().database.download(chosen.id, FORMAT, path);
    // Read after the transfer, so a dataset rebuilt between the two calls shows
    // up as a digest mismatch rather than passing against a stale digest.
    const checksums = await maxClient().database.checksums(chosen.id, FORMAT);
    return {
        id: chosen.id, size: size, bytes: bytes, path: path, checksums: checksums,
    };
}

// The newest version of the family, so a `_v2` supersedes `_v1` without an edit.
function pick(datasets) {
    return datasets
        .filter((d) => d.id === DATASET || d.id.startsWith(`${DATASET}_v`))
        .sort((a, b) => a.id.localeCompare(b.id))
        .pop();
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
