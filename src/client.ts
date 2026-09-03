import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';
import pRetry from 'p-retry';

import { createClient, createConfig } from './generated/client/index.js';
import type { Client } from './generated/client/index.js';
import {
    databaseChecksum, databaseMetadata, downloadDatabase, listDatabases,
    listDownloads, lookupIp,
} from './generated/sdk.gen.js';
import type {
    DatasetMetadata, Download, LicensedDataset, LookupResponse,
} from './generated/types.gen.js';
import { bogonResult, isBogon } from './bogon.js';
import { errorFromResponse, VPNDetectionError } from './errors.js';
import { toResult, type Result } from './types.js';

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
        this.client = createClient(createConfig({
            baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
            ...(options.apiKey === undefined ? {} : { auth: () => options.apiKey }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }));
        this.cache = options.cache === false ? null : new LRUCache<string, Result>({
            max: options.cache?.max ?? 10_000,
            ttl: options.cache?.ttlMs ?? 60 * 60 * 1000,
        });
        this.limit = pLimit(options.concurrency ?? 8);
        this.retries = options.retries ?? 2;
        this.database = new DatabaseApi(this.client, this.retries);
    }

    /**
     * Classify one address.
     *
     * A bogon is answered locally and never reaches the network. Everything
     * else is served, then cached for this instance.
     */
    async lookup(ip: string): Promise<Result> {
        if (isBogon(ip)) {
            return bogonResult(ip);
        }
        const hit = this.cache?.get(ip);
        if (hit !== undefined) {
            return hit;
        }
        const result = await withRetry(this.retries, async () => {
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
    async lookupBatch(ips: Iterable<string>): Promise<Map<string, Result | VPNDetectionError>> {
        const unique = [...new Set(ips)];
        const out = new Map<string, Result | VPNDetectionError>();
        await Promise.all(unique.map((ip) => this.limit(async () => {
            try {
                out.set(ip, await this.lookup(ip));
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
    constructor(private readonly client: Client, private readonly retries: number) {}

    async list(): Promise<LicensedDataset[]> {
        return withRetry(this.retries, async () => {
            const res = await listDatabases({ client: this.client });
            return unwrap<{ datasets: LicensedDataset[] }>(res).datasets;
        });
    }

    async metadata(id: string): Promise<DatasetMetadata> {
        return withRetry(this.retries, async () => {
            const res = await databaseMetadata({ client: this.client, query: { id: id } });
            return unwrap<DatasetMetadata>(res);
        });
    }

    async checksum(id: string, format: 'csvgz' | 'mmdb'): Promise<string> {
        return withRetry(this.retries, async () => {
            const res = await databaseChecksum({
                client: this.client, query: { id: id, format: format },
            });
            return unwrap<{ sha256: string }>(res).sha256;
        });
    }

    async downloads(): Promise<Download[]> {
        return withRetry(this.retries, async () => {
            const res = await listDownloads({ client: this.client });
            return unwrap<{ downloads: Download[] }>(res).downloads;
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
    async downloadUrl(id: string, format: 'csvgz' | 'mmdb'): Promise<string> {
        return withRetry(this.retries, async () => {
            const res = await downloadDatabase({
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
