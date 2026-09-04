import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';
import pRetry from 'p-retry';

import type { Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { createClient, createConfig } from './generated/client/index.js';
import type { Client } from './generated/client/index.js';
import {
    databaseChecksum, databaseMetadata, downloadDatabase as downloadRedirect,
    listDatabases, listDownloads, lookupIp,
} from './generated/sdk.gen.js';
import type {
    DatabaseChecksumResponses, DatabaseMetadataResponses, DatasetMetadata, Download,
    LicensedDataset, ListDatabasesResponses, ListDownloadsResponses, LookupResponse,
} from './generated/types.gen.js';

import { bogonResult, isBogon } from './bogon.js';
import { errorFromResponse, VPNDetectionError } from './errors.js';
import { toResult, type Result } from './types.js';

/** The digests published alongside a dataset file. Which ones are present varies by dataset. */
export type DatasetChecksums = DatabaseChecksumResponses[200]['checksums'];

/** The formats a dataset is published in. Not every dataset is built in both. */
export type DatasetFormat = 'csvgz' | 'mmdb';

/**
 * Where `download` puts the bytes: a path to write, or a stream you opened
 * yourself and will close yourself.
 */
export type DownloadDestination = string | Writable;

export const DEFAULT_BASE_URL = 'https://api.vpndetection.io';

export interface CacheOptions {
    /** Maximum number of addresses held. Default 10000. */
    max?: number;
    /** How long an answer stays fresh, in milliseconds. Default 1 hour. */
    ttlMs?: number;
}

export interface Options {
    /**
     * Your API key. Omit it entirely to use the free tier, which answers
     * `ip` and `is_vpn` and allows 1000 requests per day per source address.
     */
    apiKey?: string;
    baseUrl?: string;
    /** Pass `false` to disable caching. */
    cache?: CacheOptions | false;
    /** Concurrent in-flight requests during a batch. Default 8. */
    concurrency?: number;
    /** Retry attempts for a transient failure. Default 2. */
    retries?: number;
    /** Override the HTTP implementation, mostly for tests. */
    fetch?: typeof globalThis.fetch;
}

/** Per-call overrides for a single lookup. Anything omitted falls back to the client's setting. */
export interface LookupOptions {
    /** Retry attempts for a transient failure. */
    retries?: number;
}

/** Per-call overrides for one batch. Anything omitted falls back to the client's setting. */
export interface BatchOptions extends LookupOptions {
    /** Concurrent in-flight requests for THIS batch only. */
    concurrency?: number;
}

/**
 * A client for the VPNDetection API.
 *
 * The cache is per instance, so an answer is never shared between two clients
 * holding different API keys and therefore entitled to different fields.
 */
export class VPNDetection {
    private readonly client: Client;
    private readonly cache: LRUCache<string, Result> | null;
    private readonly limit: ReturnType<typeof pLimit>;
    private readonly retries: number;

    /** The licensed dataset downloads, for keys that carry the `db.download` scope. */
    readonly database: DatabaseApi;

    constructor(options: Options = {}) {
        // Resolved once, because the download path calls object storage
        // directly rather than through the generated client and has to reach
        // the same implementation a test substituted.
        const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.client = createClient(createConfig({
            baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
            ...(options.apiKey === undefined ? {} : { auth: () => options.apiKey }),
            fetch: fetchImpl,
        }));
        this.cache = options.cache === false ? null : new LRUCache<string, Result>({
            max: options.cache?.max ?? 10_000,
            ttl: options.cache?.ttlMs ?? 60 * 60 * 1000,
        });
        this.limit = pLimit(options.concurrency ?? 8);
        this.retries = options.retries ?? 2;
        this.database = new DatabaseApi(this.client, this.retries, fetchImpl);
    }

    /**
     * Whether an address is private, loopback, link-local, documentation,
     * multicast or otherwise not routable, including the IPv6 equivalents and
     * the 6to4 and Teredo ranges.
     *
     * These are the addresses `lookup` answers locally. Exposed here so the
     * check is reachable from the client you already hold; the same function is
     * also importable on its own.
     */
    isBogon(ip: string): boolean {
        return isBogon(ip);
    }

    /**
     * Classify one address.
     *
     * A bogon is answered locally and never reaches the network. Everything
     * else is served, then cached for this instance.
     */
    async lookup(ip: string, options: LookupOptions = {}): Promise<Result> {
        if (isBogon(ip)) {
            return bogonResult(ip);
        }
        const hit = this.cache?.get(ip);
        if (hit !== undefined) {
            return hit;
        }
        const result = await withRetry(options.retries ?? this.retries, async () => {
            const res = await lookupIp({ client: this.client, path: { ip: ip } });
            const body = unwrap<LookupResponse>(res);
            return toResult(body);
        });
        this.cache?.set(ip, result);
        return result;
    }

    /**
     * Classify many addresses concurrently.
     *
     * Keyed by address rather than positional, so duplicates in the input
     * collapse to a single request and the caller never has to line two lists
     * up. An address that fails carries its error as its value, so one bad
     * entry cannot lose the rest of the answers.
     */
    async lookupBatch(
        ips: Iterable<string>, options: BatchOptions = {},
    ): Promise<Map<string, Result | VPNDetectionError>> {
        const unique = [...new Set(ips)];
        // A per-call concurrency gets its own limiter; without one the call
        // would share the instance's budget and silently ignore the override.
        const limit = options.concurrency === undefined
            ? this.limit
            : pLimit(options.concurrency);
        const out = new Map<string, Result | VPNDetectionError>();
        await Promise.all(unique.map((ip) => limit(async () => {
            try {
                out.set(ip, await this.lookup(ip, options));
            } catch (err) {
                out.set(ip, asError(err));
            }
        })));
        // Reinstated in input order: Promise.all settles in completion order,
        // and a caller iterating the map should see what they passed in.
        return new Map(unique.map((ip) => [ip, out.get(ip)!]));
    }
}

/** The licensed dataset downloads. Access is granted by contract, not self-serve. */
export class DatabaseApi {
    constructor(
        private readonly client: Client,
        private readonly retries: number,
        private readonly fetchImpl: typeof globalThis.fetch,
    ) {}

    async list(): Promise<LicensedDataset[]> {
        return withRetry(this.retries, async () => {
            const res = await listDatabases({ client: this.client });
            return unwrap<ListDatabasesResponses[200]>(res).datasets;
        });
    }

    async metadata(id: string): Promise<DatasetMetadata> {
        return withRetry(this.retries, async () => {
            const res = await databaseMetadata({ client: this.client, query: { id: id } });
            return unwrap<DatabaseMetadataResponses[200]>(res);
        });
    }

    /**
     * The digests for one dataset file.
     *
     * Returns the whole set rather than one algorithm: which digests a dataset
     * publishes is the API's choice, not ours, and picking one here is how the
     * previous version came to return `undefined`.
     */
    async checksums(id: string, format: DatasetFormat): Promise<DatasetChecksums> {
        return withRetry(this.retries, async () => {
            const res = await databaseChecksum({
                client: this.client, query: { id: id, format: format },
            });
            return unwrap<DatabaseChecksumResponses[200]>(res).checksums;
        });
    }

    async downloads(): Promise<Download[]> {
        return withRetry(this.retries, async () => {
            const res = await listDownloads({ client: this.client });
            return unwrap<ListDownloadsResponses[200]>(res).downloads;
        });
    }

    /**
     * The time-limited URL for one dataset file.
     *
     * The API answers `302` to object storage. The URL is returned rather than
     * the bytes so the caller decides how to transfer a file that routinely
     * runs to gigabytes; the link authorizes the START of a transfer, so one
     * already running is not interrupted when it lapses.
     */
    async downloadUrl(id: string, format: DatasetFormat): Promise<string> {
        return withRetry(this.retries, async () => {
            const res = await downloadRedirect({
                client: this.client,
                query: { id: id, format: format },
                redirect: 'manual',
            } as never);
            if (res.response === undefined) {
                throw new VPNDetectionError('network', 'no response from the API');
            }
            const location = res.response.headers.get('location');
            if (res.response.status === 302 && location !== null) {
                return location;
            }
            unwrap<unknown>(res);
            throw new VPNDetectionError(
                'server_error', 'expected a redirect to object storage', res.response.status,
            );
        });
    }

    /**
     * Download one dataset file, streaming it to `destination`.
     *
     * `destination` is either a path or a writable stream you opened yourself.
     * A path is written through a neighboring `.part` file and renamed on
     * completion, so a transfer that dies half way leaves no truncated file
     * that reads as a whole dataset; a stream you pass is written as-is and
     * stays yours to close. Nothing is ever held in memory beyond a single
     * chunk, whatever the dataset weighs.
     *
     * Returns the number of bytes written.
     *
     * A failure DURING the transfer surfaces as the underlying error rather
     * than a `VPNDetectionError`: a reset socket and a full disk are different
     * problems and only one of them is ours.
     */
    async download(
        id: string, format: DatasetFormat, destination: DownloadDestination,
    ): Promise<number> {
        const res = await this.fetchDatasetFile(id, format);
        if (res.body === null) {
            throw new VPNDetectionError(
                'server_error', 'object storage answered with no body', res.status,
            );
        }
        const { Readable } = await import('node:stream');
        const { pipeline } = await import('node:stream/promises');
        // `node:stream/web` and the DOM lib declare the same runtime object as
        // two unrelated types, so `fromWeb` needs it restated.
        const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);

        let bytes = 0;
        async function* counted() {
            for await (const chunk of source) {
                bytes += chunk.length;
                yield chunk;
            }
        }

        if (typeof destination !== 'string') {
            await pipeline(counted(), destination);
            return bytes;
        }
        const { createWriteStream } = await import('node:fs');
        const { rename, unlink } = await import('node:fs/promises');
        const partial = `${destination}.part`;
        try {
            await pipeline(counted(), createWriteStream(partial));
        } catch (err) {
            await unlink(partial).catch(() => {});
            throw err;
        }
        await rename(partial, destination);
        return bytes;
    }

    /**
     * Download one dataset file and hand back its bytes.
     *
     * **This holds the entire file in memory**, and the catalog spans five
     * orders of magnitude: `cdn_ip_v1` is 10 KB and `relay_ip_v1` 78 KB, which
     * are nothing, while `vpn_ip_extended_v1` is a 628 MB mmdb and
     * `resproxy_ip_90d_v1` 1.79 GB of csv.gz, which will cost you that much
     * resident memory in one allocation and can fail outright. Reach for this
     * at the small end, where the bytes are going straight into a parser; use
     * `download` for anything you have not measured.
     */
    async downloadBytes(id: string, format: DatasetFormat): Promise<Uint8Array> {
        const res = await this.fetchDatasetFile(id, format);
        return new Uint8Array(await res.arrayBuffer());
    }

    // Follows the 302 as a SECOND, unauthenticated request: the presigned URL
    // carries its own authorization, so forwarding the API key would hand a
    // credential to a host that has no business holding it.
    private async fetchDatasetFile(id: string, format: DatasetFormat): Promise<Response> {
        const url = await this.downloadUrl(id, format);
        return withRetry(this.retries, async () => {
            const res = await this.fetchImpl(url);
            if (!res.ok) {
                // Left unread: the status is what separates a lapsed link from
                // a refused one, and the body is not bounded by anything.
                void res.body?.cancel();
                throw errorFromResponse(res.status, res.headers, {
                    error: `object storage refused the download link with status ${res.status}`,
                });
            }
            return res;
        });
    }
}

// The generated client puts a non-2xx body on `error` rather than `data`, and
// types `response` as optional because a transport failure produces neither.
interface Res { data?: unknown, error?: unknown, response?: Response }

function unwrap<T>(res: Res): T {
    if (res.response === undefined) {
        throw new VPNDetectionError('network', 'no response from the API');
    }
    if (!res.response.ok) {
        throw errorFromResponse(res.response.status, res.response.headers, res.error ?? res.data);
    }
    return res.data as T;
}

// p-retry owns the backoff schedule; the extra sleep here is what honors a
// server-supplied Retry-After, which p-retry has no way to know about. A 429
// carrying that header is the only 429 worth retrying, which is why the wait
// and the retry decision both key off the same field.
async function withRetry<T>(retries: number, fn: () => Promise<T>): Promise<T> {
    try {
        return await pRetry(fn, {
            retries: retries,
            shouldRetry: ({ error }) => !(error instanceof VPNDetectionError) || error.retryable,
            onFailedAttempt: async ({ error }) => {
                const seconds = error instanceof VPNDetectionError ? error.retryAfterSeconds : undefined;
                if (seconds !== undefined && seconds > 0) {
                    await new Promise((r) => setTimeout(r, seconds * 1000));
                }
            },
        });
    } catch (err) {
        throw asError(err);
    }
}

function asError(err: unknown): VPNDetectionError {
    if (err instanceof VPNDetectionError) {
        return err;
    }
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof VPNDetectionError) {
        return cause;
    }
    return new VPNDetectionError('network', err instanceof Error ? err.message : String(err));
}
