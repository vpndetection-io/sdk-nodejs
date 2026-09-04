// The dataset download path, exercised against a real HTTP origin rather than a
// fetch stub: the whole point of these methods is what fetch does with a 302 and
// with a body too large to hold, and a stub answers neither question.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { after, test } from 'node:test';

import { VPNDetection, VPNDetectionError } from '../dist/index.js';

const SMALL = Buffer.from('id,provider\n45.83.91.1,mullvad\n');
const MIB = Buffer.alloc(1024 * 1024, 0x61);

// Serves the API's 302 and the object storage it points at, on one origin, and
// records every request so a test can assert what did NOT happen.
function origin({ blobBytes = SMALL.length, storageStatus = 200, dieAfterBytes = null } = {}) {
    const seen = [];
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        seen.push({
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            headers: req.headers,
        });
        if (url.pathname === '/api/v1/database/download') {
            res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/blob` });
            res.end();
            return;
        }
        if (url.pathname !== '/blob') {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'no such path' }));
            return;
        }
        if (storageStatus !== 200) {
            res.writeHead(storageStatus, { 'content-type': 'application/xml' });
            res.end('<Error><Code>AccessDenied</Code></Error>');
            return;
        }
        res.writeHead(200, {
            'content-length': String(blobBytes),
            'content-type': 'application/octet-stream',
        });
        if (dieAfterBytes !== null) {
            // Promises `blobBytes` and delivers fewer, then drops the socket:
            // the transfer fails with a destination already part written.
            res.write(MIB.subarray(0, dieAfterBytes));
            setImmediate(() => res.destroy());
            return;
        }
        Readable.from(body(blobBytes)).pipe(res);
    });
    return { server: server, seen: seen };
}

function* body(total) {
    if (total === SMALL.length) {
        yield SMALL;
        return;
    }
    for (let sent = 0; sent < total; sent += MIB.length) {
        yield MIB.subarray(0, Math.min(MIB.length, total - sent));
    }
}

async function start(opts) {
    const o = origin(opts);
    await new Promise((r) => o.server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${o.server.address().port}`;
    const client = new VPNDetection({ baseUrl: baseUrl, apiKey: 'secret-key', cache: false });
    return { ...o, baseUrl: baseUrl, client: client };
}

const tmp = mkdtempSync(join(tmpdir(), 'vpndetection-dl-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('downloadUrl returns the Location and does not follow it', async (t) => {
    const o = await start();
    t.after(() => o.server.close());

    const url = await o.client.database.downloadUrl('cdn_ip_v1', 'csvgz');

    assert.equal(url, `${o.baseUrl}/blob`);
    assert.deepEqual(o.seen.map((r) => r.path), ['/api/v1/database/download']);
});

test('downloadDatabase follows the 302 and writes the file', async (t) => {
    const o = await start();
    t.after(() => o.server.close());
    const dest = join(tmp, 'cdn_ip_v1.csv.gz');

    const bytes = await o.client.database.downloadDatabase('cdn_ip_v1', 'csvgz', dest);

    assert.equal(bytes, SMALL.length);
    assert.deepEqual(readFileSync(dest), SMALL);
    assert.deepEqual(o.seen.map((r) => r.path), ['/api/v1/database/download', '/blob']);
});

test('downloadDatabase accepts a writable stream', async (t) => {
    const o = await start();
    t.after(() => o.server.close());
    const got = [];
    const sink = new Writable({
        write(chunk, _enc, cb) {
            got.push(Buffer.from(chunk));
            cb();
        },
    });

    const bytes = await o.client.database.downloadDatabase('cdn_ip_v1', 'csvgz', sink);

    assert.equal(bytes, SMALL.length);
    assert.deepEqual(Buffer.concat(got), SMALL);
});

test('downloadDatabaseBytes returns the bytes', async (t) => {
    const o = await start();
    t.after(() => o.server.close());

    const bytes = await o.client.database.downloadDatabaseBytes('cdn_ip_v1', 'csvgz');

    assert.ok(bytes instanceof Uint8Array);
    assert.deepEqual(Buffer.from(bytes), SMALL);
});

// The key authorizes the API call that mints the link. The link is presigned and
// authorizes itself, so forwarding the key on would hand a credential to a host
// that has no business seeing it.
test('the API key reaches the API and never object storage', async (t) => {
    const o = await start();
    t.after(() => o.server.close());

    await o.client.database.downloadDatabase('cdn_ip_v1', 'csvgz', join(tmp, 'keys.csv.gz'));

    const api = o.seen.find((r) => r.path === '/api/v1/database/download');
    const storage = o.seen.find((r) => r.path === '/blob');
    assert.match(api.headers.authorization ?? '', /secret-key/);
    assert.equal(storage.headers.authorization, undefined);
    assert.equal(storage.headers['x-api-key'], undefined);
    assert.deepEqual(storage.query, {});
    assert.ok(
        !JSON.stringify(storage.headers).includes('secret-key'),
        `the key leaked to object storage: ${JSON.stringify(storage.headers)}`,
    );
});

// The assertion that matters most: a 2 GiB body has to move through the process
// without ever being resident. The threshold is an eighth of the payload, so a
// buffering implementation cannot slip under it.
test('a large body is streamed, not buffered', async (t) => {
    const SIZE = 2 * 1024 * 1024 * 1024;
    const o = await start({ blobBytes: SIZE });
    t.after(() => o.server.close());
    const sink = new Writable({
        write(_chunk, _enc, cb) {
            cb();
        },
    });

    const before = process.memoryUsage().rss;
    const bytes = await o.client.database.downloadDatabase('vpn_ip_extended_v1', 'mmdb', sink);
    const grewMib = (process.memoryUsage().rss - before) / (1024 * 1024);

    assert.equal(bytes, SIZE, 'the whole body must have been transferred');
    assert.ok(grewMib < 256, `resident memory grew ${grewMib.toFixed(1)} MiB for a 2048 MiB body`);
});

test('object storage refusing the link is not reported as a lookup failure', async (t) => {
    const o = await start({ storageStatus: 403 });
    t.after(() => o.server.close());
    const client = new VPNDetection({ baseUrl: o.baseUrl, apiKey: 'k', retries: 0 });

    await assert.rejects(
        () => client.database.downloadDatabaseBytes('cdn_ip_v1', 'csvgz'),
        (err) => {
            assert.ok(err instanceof VPNDetectionError);
            assert.equal(err.kind, 'forbidden');
            assert.equal(err.retryable, false);
            assert.match(err.message, /object storage/);
            return true;
        },
    );
});

// A truncated file that looks complete is worse than no file: the next run reads
// it as a whole dataset. The bytes land beside the destination and the name only
// appears on success.
test('a transfer that dies part way leaves nothing at the destination', async (t) => {
    const o = await start({ blobBytes: 4 * MIB.length, dieAfterBytes: MIB.length });
    t.after(() => o.server.close());
    const client = new VPNDetection({ baseUrl: o.baseUrl, apiKey: 'k', retries: 0 });
    const dest = join(tmp, 'half-a-dataset.csv.gz');

    await assert.rejects(() => client.database.downloadDatabase('cdn_ip_v1', 'csvgz', dest));
    assert.throws(() => readFileSync(dest), { code: 'ENOENT' });
    assert.throws(() => readFileSync(`${dest}.part`), { code: 'ENOENT' });
});
