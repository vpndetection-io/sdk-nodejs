import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';

import type { Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { createClient, createConfig } from './generated/client/index.js';
import type { Client } from './generated/client/index.js';
import { VERSION } from './generated/version.js';
import {
    myEntitlement, databaseChecksum, databaseMetadata, downloadDatabase as downloadRedirect,
    listDatabases, listDownloads, lookupBatch, lookupIp, lookupMyIp,
} from './generated/sdk.gen.js';
import type {
    Entitlement, Database, DatabaseFormat, DatabaseMetadata, DbChecksums, Download,
    ListDatabasesResponses, ListDownloadsResponses, LookupResponse, BatchLookupResponse,
} from './generated/types.gen.js';

import { bogonResult, isBogon, unmapped } from './bogon.js';
import { loadNodeBuiltin } from './builtin.js';
import { errorFromEntry, errorFromResponse, VPNDetectionError } from './errors.js';
import { OauthApi } from './oauth.js';
import {
    isBatch, isBatchError, isChecksumsResponse, isDatabaseList, isDatabaseMetadata, isDownloadList, isEntitlement,
    isLookup,
} from './shapes.js';
import {
    asError, checkConcurrency, checkRetries, checkTimeout, deadline, readable, unwrap, withRetry,
} from './transport.js';
import { DATABASE_FORMATS, toResult, type Result } from './types.js';

/**
 * Where `download` puts the bytes: a path to write, or a stream you opened
 * yourself and will close yourself.
 */
export type DownloadDestination = string | Writable;

export const DEFAULT_BASE_URL = 'https://api.vpndetection.io';

// Matches the other SDKs, whose HTTP clients default to 30s. Node's global
// fetch has no whole-request limit of its own, so without this a hung API holds
// a caller until undici's 300s headers timeout - which is why this exists.
const DEFAULT_TIMEOUT_MS = 30_000;

// The most addresses POST /batch takes in one call; a larger batch is sent in
// chunks of this size.
const BATCH_MAX = 1000;

export interface CacheOptions {
    /** Maximum number of addresses held, a whole number from 1. Default 10000. */
    max?: number;
    /**
     * How long an answer stays fresh, in whole milliseconds from 1. Default 1 hour.
     * An answer marked `trialExpired` or `capReached` stays a minute at most.
     */
    ttlMs?: number;
}

export interface DownloadsOptions {
    /** How many attempts to return, newest first. The API clamps this to 200. */
    limit?: number;
    /**
     * How long one attempt may take before it is abandoned, in milliseconds, for
     * THIS call only. Defaults to the client's `timeoutMs`.
     */
    timeoutMs?: number;
}

export interface DownloadOptions {
    /**
     * One build of the dataset, by the name a `database.updated` webhook gives
     * it, so the file is the one whose `sha256` the webhook carries. Without
     * it, the build that is live. A build is kept 7 days; one pruned since is
     * a `bad_request` with status 410.
     */
    build?: string;
    // No `timeoutMs`: a transfer runs for minutes and is exempt from any timeout,
    // and the link request runs on the client's. One passed is refused as a
    // `bad_request`, never dropped.
}

export interface Options {
    /**
     * Your API key. Without one a lookup is on Unlimited, the free plan: `ip`,
     * `is_vpn`, the Tor and relay members, `is_anycast`, `hostname`, `location`
     * and `asn`, with no daily or monthly cap. A batch needs a key on a paid plan.
     */
    apiKey?: string;
    baseUrl?: string;
    /** Pass `false` to disable caching. */
    cache?: CacheOptions | false;
    /**
     * Concurrent batch requests - chunks of up to 1000 addresses - during a
     * batch, a whole number from 1. Default 8.
     */
    concurrency?: number;
    /** Retry attempts for a transient failure, a whole number from 0. Default 2. */
    retries?: number;
    /**
     * How long one request may take before it is abandoned, in milliseconds.
     * Default 30000. Applies per attempt, so a retried call may take longer in
     * total. A dataset transfer is deliberately exempt: it is expected to run
     * for minutes.
     */
    timeoutMs?: number;
    /** Override the HTTP implementation, mostly for tests. */
    fetch?: typeof globalThis.fetch;
}

/** Per-call overrides for one call. Anything omitted falls back to the client's setting. */
export interface CallOptions {
    /** Retry attempts for a transient failure, a whole number from 0. */
    retries?: number;
    /** How long one attempt may take before it is abandoned, in milliseconds. */
    timeoutMs?: number;
}

/** Per-call options for `lookup` and `myIp`. */
export interface LookupOptions extends CallOptions {
    /**
     * The `User-Agent` of the client that came from this address. With every field, on a paid
     * plan or the trial, the answer's `userAgent` then names the agent it claims to be and whether
     * this address bears that out. The empty string sends none, and a longer one than the API's
     * 1024 characters is sent whole for the API to cut.
     */
    userAgent?: string;
}

/** Per-call overrides for one batch. Anything omitted falls back to the client's setting. */
export interface BatchOptions extends CallOptions {
    /** Concurrent batch requests for THIS batch only. */
    concurrency?: number;
    /**
     * Each address's `User-Agent`, keyed by the address as you pass it in `ips`, sent as
     * `lookup`'s `userAgent` is. An address left out, or given the empty string, sends none.
     */
    userAgents?: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
}

/**
 * A client for the VPNDetection API.
 *
 * The cache is per instance, so an answer is never shared between two clients
 * holding different API keys and therefore entitled to different fields.
 */
export class VPNDetection {
    private readonly client: Client;
    // Keyed by address, and by the user agent sent with it (`cacheKey`): an
    // answer to one carries that agent's verdict. The context is how a call
    // sends the request when the key has none in flight: `fetch()` runs it
    // synchronously, so a batch knows which addresses it leads before it builds
    // a chunk.
    private readonly cache: LRUCache<string, Result, () => Promise<Result>> | null;
    private readonly limit: ReturnType<typeof pLimit>;
    private readonly retries: number;
    private readonly timeoutMs: number;

    /** The licensed dataset downloads, for keys that carry the `db.download` scope. */
    readonly database: DatabaseApi;

    /**
     * Sign a person in with the OAuth device flow, so a program on their own
     * machine can be handed one of their API keys. Needs no API key.
     */
    readonly oauth: OauthApi;

    constructor(options: Options = {}) {
        // Resolved once, because the download path calls object storage
        // directly rather than through the generated client and has to reach
        // the same implementation a test substituted.
        const fetchImpl = named(options.fetch ?? globalThis.fetch.bind(globalThis));
        const apiKey = checkApiKey(options.apiKey);
        this.client = createClient(createConfig({
            // Every path appended starts with a slash, and a second one is another
            // path, which the API answers with a redirect.
            baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
            ...(apiKey === undefined ? {} : { auth: bearerOnly(apiKey) }),
            fetch: fetchImpl,
        }));
        const ttlMs = options.cache === false ? 0 : (checkCacheOption('ttlMs', options.cache?.ttlMs) ?? 60 * 60 * 1000);
        this.cache = options.cache === false ? null : new LRUCache<string, Result, () => Promise<Result>>({
            max: checkCacheOption('max', options.cache?.max) ?? 10_000,
            ttl: ttlMs,
            // Concurrent misses for one key share one request: every
            // `fetch()` while it is in flight gets the same promise, and a
            // failure rejects them all and is cached for none.
            fetchMethod: async (_ip, _stale, { context, options }) => {
                const result = await context();
                options.ttl = lifeMs(result, ttlMs);
                return result;
            },
            // An eviction must not fail the callers awaiting a request.
            ignoreFetchAbort: true,
        });
        this.limit = pLimit(checkConcurrency(options.concurrency) ?? 8);
        this.retries = checkRetries(options.retries) ?? 2;
        this.timeoutMs = checkTimeout(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
        this.database = new DatabaseApi(this.client, this.retries, this.timeoutMs, fetchImpl);
        this.oauth = new OauthApi(this.client, this.retries, this.timeoutMs);
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
     * else is served, then cached for this instance, on the address and the
     * `userAgent` sent with it. Calls that miss the cache while a request for
     * their address and agent is in flight, a batch's included, await that
     * request rather than sending their own, and take its answer, sent under the
     * options of the call that led it. An IPv4-mapped address
     * (`::ffff:8.8.8.8`) is the IPv4 address it carries: judged, sent and cached
     * as that, so the answer names `8.8.8.8`. A bogon's answer carries no
     * `userAgent`.
     */
    async lookup(ip: string, options: LookupOptions = {}): Promise<Result> {
        // First, or a bogon and a cached address would answer any value.
        checkTimeout(options.timeoutMs);
        checkRetries(options.retries);
        const agent = checkUserAgent(options.userAgent);
        const addr = unmapped(ip);
        if (isBogon(addr)) {
            return bogonResult(addr);
        }
        if (this.cache === null) {
            return this.serve(addr, agent, options);
        }
        return (await this.cache.fetch(cacheKey(addr, agent), {
            context: () => this.serve(addr, agent, options),
        }))!;
    }

    private async serve(ip: string, agent: string | undefined, options: CallOptions): Promise<Result> {
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        return withRetry(options.retries ?? this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => lookupIp({
                client: this.client, path: { ip: ip }, signal: signal, ...agentQuery(agent),
            }));
            return toResult(readable<LookupResponse>(res, isLookup));
        });
    }

    /**
     * Classify the address this client is calling from.
     *
     * The same answer `lookup` would give for that address, at the same cost
     * against your allowance. The address is the one our edge observed, so a
     * call made through a proxy or a VPN reports the exit it left through -
     * usually the point of asking.
     *
     * Deliberately NOT cached. The cache is keyed by address, and which
     * address this is IS the question: a machine that moves between networks
     * would otherwise be told where it used to be. `userAgent` is sent as
     * `lookup` sends it.
     */
    async myIp(options: LookupOptions = {}): Promise<Result> {
        const timeoutMs = checkTimeout(options.timeoutMs) ?? this.timeoutMs;
        const retries = checkRetries(options.retries) ?? this.retries;
        const agent = checkUserAgent(options.userAgent);
        return withRetry(retries, async () => {
            const res = await deadline(timeoutMs, (signal) => lookupMyIp({
                client: this.client, signal: signal, ...agentQuery(agent),
            }));
            return toResult(readable<LookupResponse>(res, isLookup));
        });
    }

    /**
     * What this client's key is entitled to, and how much of it has been used.
     *
     * Named for what it answers rather than `me`, which sits one letter from
     * `myIp` and means something quite different: one is which address you are
     * calling FROM, the other is what the key you are calling WITH may spend.
     *
     * Unlike a lookup there is no useful unauthenticated answer, so a client
     * built without a key gets an unauthorized error rather than a partial one.
     *
     * Usage counts against the ALLOWANCE WINDOW - on a paid plan the
     * anniversary of the subscription, not the calendar month and not the
     * billing period, and on the free plan the trial - and it is the same
     * number a lookup is gated on. It can lag by a few seconds, because
     * requests are counted in memory and flushed in aggregate.
     *
     * Deliberately NOT cached: the whole point is what has been spent, and a
     * cached answer is a wrong one within seconds of the next request.
     */
    async myEntitlement(options: CallOptions = {}): Promise<Entitlement> {
        const timeoutMs = checkTimeout(options.timeoutMs) ?? this.timeoutMs;
        return withRetry(checkRetries(options.retries) ?? this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => myEntitlement({
                client: this.client, signal: signal,
            }));
            return readable<Entitlement>(res, isEntitlement);
        });
    }

    /**
     * Classify many addresses in as few requests as possible.
     *
     * Bogons are answered locally and cached answers are reused, and an address
     * with a request already in flight, a lookup's or another batch's, awaits
     * that request; everything else goes to the batch endpoint in chunks of up
     * to 1000 addresses, with at most `concurrency` chunks in flight, and a
     * lookup arriving meanwhile awaits this batch's answer for its address. Keyed by address rather than
     * positional, so duplicates in the input collapse to a single entry and the
     * caller never has to line two lists up. An address that fails carries its
     * error as its value, so one bad entry cannot lose the rest of the answers:
     * the API reports a per-entry failure with the status the single lookup
     * would have answered, and a chunk that fails as a whole marks every
     * address in it. A per-call `concurrency` that is not a whole number from 1
     * is refused as `bad_request` before anything is sent. An IPv4-mapped address is looked
     * up as the IPv4 address it carries, and its answer keyed as you passed it.
     * The batch endpoint needs a paid plan: without a key every address in a request
     * of two or more carries an `unauthorized` error, and a free-plan key's request
     * of two or more a `bad_request` (HTTP 402). A request of one address is
     * answered as its lookup would be. `userAgents` sends an address's
     * `User-Agent` with it, only from a chunk where an address carries one, and
     * each answer is cached on its address and agent.
     */
    async lookupBatch(
        ips: Iterable<string>, options: BatchOptions = {},
    ): Promise<Map<string, Result | VPNDetectionError>> {
        const concurrency = checkConcurrency(options.concurrency);
        checkTimeout(options.timeoutMs);
        checkRetries(options.retries);
        const agents = checkUserAgents(options.userAgents);
        const asked = [...new Set(ips)];
        const unique = [...new Set(asked.map(unmapped))];
        const out = new Map<string, Result | VPNDetectionError>();
        const pending: string[] = [];
        // Every address that is neither a bogon nor cached goes through
        // `fetch()` in one synchronous pass: one with a request in flight joins
        // it, and for the rest `fetchMethod` runs at once, which is how this
        // batch learns the addresses it leads before building any chunk.
        const shared: [string, Promise<Result | undefined>][] = [];
        const led = new Map<string, PromiseWithResolvers<Result>>();
        for (const ip of unique) {
            if (isBogon(ip)) {
                out.set(ip, bogonResult(ip));
                continue;
            }
            const key = cacheKey(ip, agents.get(ip));
            const hit = this.cache?.get(key);
            if (hit !== undefined) {
                out.set(ip, hit);
                continue;
            }
            if (this.cache === null) {
                pending.push(ip);
                continue;
            }
            shared.push([ip, this.cache.fetch(key, {
                context: () => {
                    const landing = Promise.withResolvers<Result>();
                    led.set(ip, landing);
                    pending.push(ip);
                    return landing.promise;
                },
            })]);
        }
        // A per-call concurrency gets its own limiter; without one the call
        // would share the instance's budget and silently ignore the override.
        const limit = concurrency === undefined ? this.limit : pLimit(concurrency);
        const chunks: string[][] = [];
        for (let i = 0; i < pending.length; i += BATCH_MAX) {
            chunks.push(pending.slice(i, i + BATCH_MAX));
        }
        await Promise.all([
            ...chunks.map((chunk) => limit(async () => {
                for (const [ip, answer] of await this.lookupChunk(chunk, agents, options)) {
                    const landing = led.get(ip);
                    if (landing === undefined) {
                        out.set(ip, answer);
                    } else if (answer instanceof VPNDetectionError) {
                        landing.reject(answer);
                    } else {
                        landing.resolve(answer);
                    }
                }
            })),
            ...shared.map(async ([ip, answer]) => {
                try {
                    out.set(ip, (await answer)!);
                } catch (err) {
                    out.set(ip, asError(err));
                }
            }),
        ]);
        // Reinstated in input order, under the addresses as passed: chunks
        // settle in completion order, and a caller iterating the map should see
        // what they passed in.
        return new Map(asked.map((ip) => [ip, out.get(unmapped(ip))!]));
    }

    // One POST /batch, mapped back onto the addresses it was asked about. A
    // chunk-level failure - the call refused, the transport failing, the
    // retries exhausted - becomes every address's error, exactly as it would
    // have been had each been looked up alone.
    private async lookupChunk(
        chunk: string[], agents: Map<string, string>, options: CallOptions,
    ): Promise<Map<string, Result | VPNDetectionError>> {
        const out = new Map<string, Result | VPNDetectionError>();
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        // Only where an address of THIS chunk carries an agent, never as `{}`,
        // and keyed by each address exactly as `ips` sends it.
        const sent = chunk.filter((ip) => agents.has(ip)).map((ip) => [ip, agents.get(ip)!] as const);
        const request = sent.length === 0 ? { ips: chunk } : { ips: chunk, user_agents: Object.fromEntries(sent) };
        let body: BatchLookupResponse;
        try {
            body = await withRetry(options.retries ?? this.retries, async () => {
                const res = await deadline(timeoutMs, (signal) => lookupBatch({
                    client: this.client, body: request, signal: signal,
                }));
                return readable<BatchLookupResponse>(res, isBatch);
            });
        } catch (err) {
            const failure = asError(err);
            for (const ip of chunk) {
                out.set(ip, failure);
            }
            return out;
        }
        // An entry is judged alone: one the client cannot read is that address's
        // error, and the rest of the chunk keeps its answers. Each map is read by
        // its own keys alone: through 5.8.0 `__proto__`, `constructor` and
        // `toString` read the object's prototype as a served answer, so the API's
        // 400 for each came back as an unreadable 200.
        for (const ip of chunk) {
            const served = Object.hasOwn(body.results, ip) ? body.results[ip] : undefined;
            if (served !== undefined) {
                // Cached by the `fetch()` this batch leads it through.
                out.set(ip, isLookup(served) ? toResult(served) : unreadableEntry(ip));
                continue;
            }
            const failed = Object.hasOwn(body.errors, ip) ? body.errors[ip] : undefined;
            if (failed !== undefined) {
                out.set(ip, isBatchError(failed) ? errorFromEntry(failed) : unreadableEntry(ip));
                continue;
            }
            out.set(ip, new VPNDetectionError(
                'server_error', `the batch answer did not include ${ip}`, 200,
            ));
        }
        return out;
    }
}

/**
 * The key without the blanks around it, and no key at all for blanks alone,
 * which went out as `Authorization: Bearer` (5.5.1, measured 2026-10-12). A
 * control character inside it is refused here: fetch refuses such a header, so
 * every call failed as a `network` error with nothing sent. `null` is no key,
 * as it always was.
 */
function checkApiKey(apiKey: unknown): string | undefined {
    if (apiKey === undefined || apiKey === null) {
        return undefined;
    }
    if (typeof apiKey !== 'string') {
        throw new VPNDetectionError('bad_request', `apiKey must be a string, got ${typeof apiKey}`);
    }
    const key = apiKey.trim();
    if (/[\u0000-\u001f\u007f]/.test(key)) {
        throw new VPNDetectionError('bad_request', 'apiKey must not contain a control character');
    }
    // fetch sends a header as Latin-1 and refuses anything past it, so through 5.10.0
    // such a key failed every call as a retried network error with nothing sent.
    if (/[^\u0000-\u00ff]/.test(key)) {
        throw new VPNDetectionError('bad_request', 'apiKey must not contain a character past U+00FF');
    }
    return key === '' ? undefined : key;
}

/**
 * The user agent a lookup sends, `undefined` for none: the empty string is none,
 * as the API reads `user_agent=`, and a long one is sent whole for the API to cut.
 * Anything but a string is refused before it can reach the query string.
 */
function checkUserAgent(userAgent: unknown): string | undefined {
    if (userAgent === undefined || userAgent === null || userAgent === '') {
        return undefined;
    }
    if (typeof userAgent !== 'string') {
        throw new VPNDetectionError('bad_request', `userAgent must be a string, got ${typeof userAgent}`);
    }
    return userAgent;
}

/** A batch's user agents, keyed by each address as the batch sends it, every empty one dropped. */
function checkUserAgents(userAgents: unknown): Map<string, string> {
    const agents = new Map<string, string>();
    if (userAgents === undefined || userAgents === null) {
        return agents;
    }
    if (typeof userAgents !== 'object') {
        throw new VPNDetectionError('bad_request', `userAgents must map addresses to agents, got ${typeof userAgents}`);
    }
    const entries = userAgents instanceof Map ? [...userAgents.entries()] : Object.entries(userAgents);
    for (const [ip, agent] of entries) {
        const checked = checkUserAgent(agent);
        if (checked !== undefined) {
            agents.set(unmapped(String(ip)), checked);
        }
    }
    return agents;
}

// An answer to an address with an agent carries that agent's verdict, so it is
// never served for the address alone or for another agent. The address alone
// stays the key of a lookup sending none.
function cacheKey(ip: string, agent: string | undefined): string {
    return agent === undefined ? ip : JSON.stringify([ip, agent]);
}

/**
 * The query a lookup sends its agent in, every reserved character percent-encoded,
 * `+` among them, which a server reads as a space. Set by hand, so nothing checks
 * the spec's 1024-character bound before the API cuts it.
 */
function agentQuery(agent: string | undefined): { query?: { user_agent: string }; querySerializer?: (query: Record<string, unknown>) => string } {
    if (agent === undefined) {
        return {};
    }
    return { query: { user_agent: agent }, querySerializer: strictQuery };
}

function strictQuery(query: Record<string, unknown>): string {
    return Object.entries(query).filter(([, value]) => value !== undefined && value !== null)
        .map(([name, value]) => `${strictEncode(name)}=${strictEncode(String(value))}`).join('&');
}

function strictEncode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function unreadableEntry(ip: string): VPNDetectionError {
    return new VPNDetectionError('server_error', `unreadable batch answer for ${ip}, status 200`, 200);
}

/** The licensed dataset downloads. Access is granted by contract, not self-serve. */
export class DatabaseApi {
    constructor(
        private readonly client: Client,
        private readonly retries: number,
        private readonly timeoutMs: number,
        private readonly fetchImpl: typeof globalThis.fetch,
    ) {}

    async list(): Promise<Database[]> {
        return withRetry(this.retries, async () => {
            const res = await deadline(this.timeoutMs, (signal) => listDatabases({
                client: this.client, signal: signal,
            }));
            return readable<ListDatabasesResponses[200]>(res, isDatabaseList).databases;
        });
    }

    async metadata(id: string): Promise<DatabaseMetadata> {
        return withRetry(this.retries, async () => {
            const res = await deadline(this.timeoutMs, (signal) => databaseMetadata({
                client: this.client, query: { id: id }, signal: signal,
            }));
            return readable<DatabaseMetadata>(res, isDatabaseMetadata);
        });
    }

    /**
     * The digests for one dataset file.
     *
     * Returns the whole set rather than one algorithm: which digests a dataset
     * publishes is the API's choice, not ours, and picking one here is how the
     * previous version came to return `undefined`.
     */
    async checksums(id: string, format: DatabaseFormat): Promise<DbChecksums> {
        assertFormat(format);
        return withRetry(this.retries, async () => {
            const res = await deadline(this.timeoutMs, (signal) => databaseChecksum({
                client: this.client, query: { id: id, format: format }, signal: signal,
            }));
            return readable<{ checksums: DbChecksums }>(res, isChecksumsResponse).checksums;
        });
    }

    /**
     * Your organization's recent download attempts, newest first.
     *
     * Refusals are listed too: a denial is what answers "it stopped working",
     * and its absence answers nothing.
     */
    async downloads(options: DownloadsOptions = {}): Promise<Download[]> {
        const timeoutMs = checkTimeout(options.timeoutMs) ?? this.timeoutMs;
        return withRetry(this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => listDownloads({
                client: this.client,
                ...(options.limit === undefined ? {} : { query: { limit: options.limit } }),
                signal: signal,
            }));
            return readable<ListDownloadsResponses[200]>(res, isDownloadList).downloads;
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
    async downloadUrl(
        id: string, format: DatabaseFormat, options: DownloadOptions = {},
    ): Promise<string> {
        refuseTimeout('downloadUrl', options);
        assertFormat(format);
        const build = options.build ?? undefined;
        return withRetry(this.retries, async () => {
            const res = await deadline(this.timeoutMs, (signal) => downloadRedirect({
                client: this.client,
                query: { id: id, format: format, ...(build === undefined ? {} : { build: build }) },
                redirect: 'manual',
                signal: signal,
            } as never));
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
        id: string, format: DatabaseFormat, destination: DownloadDestination,
        options: DownloadOptions = {},
    ): Promise<number> {
        refuseTimeout('download', options);
        const res = await this.fetchDatabaseFile(id, format, options);
        if (res.body === null) {
            throw new VPNDetectionError(
                'server_error', 'object storage answered with no body', res.status,
            );
        }
        const { Readable } = await loadNodeBuiltin<typeof import('node:stream')>('node:stream');
        const { pipeline } = await loadNodeBuiltin<typeof import('node:stream/promises')>('node:stream/promises');
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
        const { createWriteStream } = await loadNodeBuiltin<typeof import('node:fs')>('node:fs');
        const { rename, unlink } = await loadNodeBuiltin<typeof import('node:fs/promises')>('node:fs/promises');
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
    async downloadBytes(
        id: string, format: DatabaseFormat, options: DownloadOptions = {},
    ): Promise<Uint8Array> {
        refuseTimeout('downloadBytes', options);
        const res = await this.fetchDatabaseFile(id, format, options);
        return new Uint8Array(await res.arrayBuffer());
    }

    // Follows the 302 as a SECOND, unauthenticated request: the presigned URL
    // carries its own authorization, so forwarding the API key would hand a
    // credential to a host that has no business holding it.
    private async fetchDatabaseFile(
        id: string, format: DatabaseFormat, options: DownloadOptions,
    ): Promise<Response> {
        const url = await this.downloadUrl(id, format, options);
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

/**
 * Sends the key in the `Authorization` header and nowhere else.
 *
 * The API accepts three credential forms and the spec documents all three, so
 * the generator applies EVERY one of them - putting the key in the query string
 * of every request alongside the headers. A query string is the one place a
 * secret should never be: it lands in access logs, proxy logs and browser
 * history, none of which we control. `?apikey=` exists for a human with curl or
 * a browser bar, not for a client that can set a header.
 *
 * Returning undefined for the other schemes is what suppresses them; the
 * generated `getAuthToken` drops a scheme whose callback yields nothing.
 */
function bearerOnly(apiKey: string): (auth: { scheme?: string }) => string | undefined {
    return (auth) => (auth.scheme === 'bearer' ? apiKey : undefined);
}

/**
 * Names the SDK on every request it sends, the API's, OAuth's and object
 * storage's alike: without it a request reads as fetch's `node`, so neither this
 * SDK's traffic nor which versions are still in use can be counted. A fetch passed
 * in sees the header already set, so a program wrapping the SDK can put its own
 * name first.
 */
function named(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
    const userAgent = `vpndetection-nodejs/${VERSION}`;
    return (input, init) => {
        if (input instanceof Request) {
            if (!input.headers.has('user-agent')) {
                input.headers.set('user-agent', userAgent);
            }
            return fetchImpl(input, init);
        }
        const headers = new Headers(init?.headers);
        if (!headers.has('user-agent')) {
            headers.set('user-agent', userAgent);
        }
        return fetchImpl(input, { ...init, headers: headers });
    };
}

/**
 * Rejects a format the API does not publish, before the network sees it.
 *
 * The generated union guards a TypeScript caller at COMPILE time and nobody
 * else: a format arriving from a CLI flag, a form field or a model is a plain
 * string, and without this it costs a round trip and comes back as a 400 whose
 * message names nothing the caller can act on. Ruby, PHP, Python, Java and Perl
 * all reject locally; this is Node catching up.
 */
function assertFormat(format: DatabaseFormat): void {
    if (DATABASE_FORMATS.includes(format)) {
        return;
    }
    throw new VPNDetectionError(
        'bad_request',
        `invalid format ${JSON.stringify(format)}; must be one of ${DATABASE_FORMATS.join(', ')}`,
    );
}

/**
 * A per-call `timeoutMs` on a dataset call that takes none, refused before
 * anything is sent. TypeScript stops it on a literal and nobody else: through
 * 5.19.1 a JavaScript caller's was dropped and the call waited the client's
 * full timeout, where the caller had asked for less.
 */
function refuseTimeout(method: string, options: DownloadOptions): void {
    if ((options as { timeoutMs?: unknown }).timeoutMs === undefined) {
        return;
    }
    throw new VPNDetectionError(
        'bad_request', `${method} takes no per-call timeoutMs: the link request runs on the client's, and a transfer on none`,
    );
}

/**
 * A cache size or TTL refused where it is set, `null` reading as unset. lru-cache
 * reads a zero or NaN TTL as none, which would keep every answer for good, a spent
 * trial's included, and a zero size as no bound; anything else not whole it throws
 * a bare TypeError for.
 */
function checkCacheOption(name: 'max' | 'ttlMs', value: number | null | undefined): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!(typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)) {
        throw new VPNDetectionError('bad_request', `cache.${name} must be a whole number from 1, got ${String(value)}`);
    }
    return value;
}

// A reduced answer, a spent trial's or a reached cap's, ends with a renewed trial or
// a raised cap, so it stays a minute at most rather than the TTL. It is still
// cached, or a busy process would send every repeat of an address to the API.
function lifeMs(result: Result, ttlMs: number): number {
    if (result.trialExpired === true || result.capReached === true) {
        return Math.min(ttlMs, REDUCED_TTL_MS);
    }
    return ttlMs;
}

const REDUCED_TTL_MS = 60_000;
