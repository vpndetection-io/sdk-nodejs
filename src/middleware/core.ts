import { isBogon } from '../bogon.js';
import { VPNDetection, type CacheOptions } from '../client.js';
import { VPNDetectionError } from '../errors.js';
import type { Result } from '../types.js';

import { constraintCount, matchesCondition, missingMembers, type BlockCondition } from './condition.js';

/**
 * Enough of an incoming request for a selector to work with, whatever
 * framework it came from. An adapter supplies one of these per request.
 */
export interface RequestView {
    /** A request header by name, case-insensitively. */
    header(name: string): string | undefined;
    /** The framework's own client-address accessor, whatever that resolves to here. */
    frameworkIp(): string | undefined;
}

/**
 * How the client address is decided.
 *
 * There is no portable answer: a framework's own accessor may return the
 * socket peer, or may already have walked a proxy chain, depending on the
 * framework and on how the application configured it. You know your framework
 * and your edge, so this is yours to choose.
 */
export type IpSelector<Req> = (request: Req) => string | undefined;

/** What a lookup attached to the request, whether or not it succeeded. */
export interface Lookup {
    /** The address that was classified, as the selector resolved it. */
    ip?: string;
    /** The answer. Absent when the lookup failed. */
    result?: Result;
    /** Why the lookup failed. Absent when it succeeded. */
    error?: VPNDetectionError;
    /** Whether the condition matched. Always false when no condition was configured. */
    blocked: boolean;
}

/** What to do when a condition names a member the plan does not serve. */
export type MissingFieldAction = 'warn' | 'throw' | 'ignore';

export interface MiddlewareOptions<Req> {
    /**
     * An existing client to use. Prefer this if you already hold one: two
     * clients mean two caches, and a cache is per instance because two keys can
     * be on different plans and entitled to different fields.
     */
    client?: VPNDetection;
    /** Your API key. Ignored when `client` is given. */
    apiKey?: string;
    /** Ignored when `client` is given. */
    baseUrl?: string;
    /** Ignored when `client` is given. Pass `false` to disable caching. */
    cache?: CacheOptions | false;
    /**
     * How long a lookup may hold the request, in milliseconds. Default 2500.
     *
     * This sits on the request path, so it is a much tighter bound than the
     * client's own 30s default.
     */
    timeoutMs?: number;
    /**
     * Retry attempts for a transient failure. Default 0, unlike the client's 2:
     * on a request path, failing open quickly beats holding a visitor while we
     * try again.
     */
    retries?: number;
    /** How the client address is decided. Defaults to the framework's own accessor. */
    ipSelector?: IpSelector<Req>;
    /**
     * What to block on. Omit it to only enrich the request and leave the
     * decision to your own code.
     */
    blockCondition?: BlockCondition | BlockCondition[];
    /**
     * Block when the lookup itself fails. Default false, so our outage does not
     * become yours.
     */
    failClosed?: boolean;
    /** What to do when the condition names a member your plan does not serve. Default `warn`. */
    onMissingField?: MissingFieldAction;
    /** Skip classification for this request entirely. */
    skip?: (request: Req) => boolean;
    /** Where warnings go. Defaults to `console.warn`. */
    onWarn?: (message: string) => void;
}

export interface Core<Req> {
    /** Classify one request. Answers `undefined` when `skip` claimed it. */
    evaluate(request: Req): Promise<Lookup | undefined>;
}

/**
 * The framework-agnostic half of a middleware: resolve an address, classify it,
 * and decide whether the condition matched.
 *
 * Adapters own the framework-shaped parts - reading a request, attaching the
 * answer, and refusing a request - and share everything here.
 */
export function createCore<Req>(
    options: MiddlewareOptions<Req>,
    defaultIpSelector: IpSelector<Req>,
): Core<Req> {
    const condition = options.blockCondition;
    if (condition !== undefined && constraintCount(condition) === 0) {
        throw new Error(
            'vpndetection: blockCondition constrains nothing, which would block every request. '
            + 'A member set to false or null is ignored; state the positive signals you act on.',
        );
    }

    const client = options.client ?? new VPNDetection({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        cache: options.cache,
    });
    const selector = options.ipSelector ?? defaultIpSelector;
    const lookupOptions = {
        timeoutMs: options.timeoutMs ?? 2500,
        retries: options.retries ?? 0,
    };
    const warn = onceEach(options.onWarn ?? ((message) => console.warn(message)));

    return {
        evaluate: async (request: Req): Promise<Lookup | undefined> => {
            if (options.skip?.(request) === true) {
                return undefined;
            }
            const ip = selector(request)?.trim();
            if (ip === undefined || ip === '') {
                warn('could not resolve a client address from this request; '
                    + 'pass an ipSelector that knows where yours comes from');
                return {
                    error: new VPNDetectionError('bad_request', 'no client address on the request'),
                    blocked: options.failClosed === true,
                };
            }
            if (isBogon(ip)) {
                // Expected in local development. Anywhere else it means a proxy
                // sits in front and its own address is what reached us.
                warn(`resolved the client address as ${ip}, which is not a public address. `
                    + 'If this application runs behind a proxy or load balancer, configure its '
                    + 'trusted-proxy setting or pass an ipSelector that reads your edge\'s header.');
            }

            let result: Result;
            try {
                result = await client.lookup(ip, lookupOptions);
            } catch (err) {
                return {
                    ip: ip,
                    error: err instanceof VPNDetectionError
                        ? err
                        : new VPNDetectionError('network', String(err)),
                    blocked: options.failClosed === true,
                };
            }
            if (condition !== undefined) {
                reportMissing(condition, result, options.onMissingField ?? 'warn', warn);
            }
            return {
                ip: ip,
                result: result,
                blocked: condition !== undefined && matchesCondition(condition, result),
            };
        },
    };
}

/**
 * Selectors bound to one framework's request type.
 *
 * An adapter calls this once with a function that exposes its own request, and
 * gets the shared implementations back under its own signature - so a caller
 * writing a custom selector still works with the request object they know.
 */
export function bindSelectors<Req>(view: (request: Req) => RequestView) {
    return {
        /**
         * The framework's own client-address accessor. What that resolves to
         * depends on the framework and on how you configured it.
         */
        defaultIpSelector: (request: Req) => view(request).frameworkIp(),

        /**
         * An address from `X-Forwarded-For`.
         *
         * **The left-most entry is whatever the caller sent.** Proxies append,
         * so a visitor who sets the header themselves appears first in the list
         * and this returns their forgery. It is only trustworthy when an edge
         * you control overwrites the header rather than appending to it. When
         * you know how many proxies sit in front, count from the right with
         * `depth` instead: `depth: 1` is the address your nearest proxy saw.
         */
        xffIpSelector: (options: { depth?: number } = {}) => (request: Req) => {
            const v = view(request);
            const chain = (v.header('x-forwarded-for') ?? '')
                .split(',').map((e) => e.trim()).filter((e) => e !== '');
            if (chain.length === 0) {
                return v.frameworkIp();
            }
            const depth = options.depth ?? 0;
            return depth <= 0 ? chain[0] : chain[chain.length - depth];
        },

        /**
         * An address from a single-value header, by name - for an edge that
         * writes one. `headerIpSelector('CF-Connecting-IP')` behind Cloudflare,
         * `headerIpSelector('True-Client-IP')` behind Akamai, and so on.
         *
         * Falls back to the framework's accessor when the header is absent.
         */
        headerIpSelector: (name: string) => (request: Req) => {
            const v = view(request);
            return v.header(name)?.trim() || v.frameworkIp();
        },
    };
}

function reportMissing(
    condition: BlockCondition | BlockCondition[], result: Result,
    action: MissingFieldAction, warn: (message: string) => void,
) {
    if (action === 'ignore') {
        return;
    }
    const missing = missingMembers(condition, result);
    if (missing.length === 0) {
        return;
    }
    const message = `blockCondition names ${missing.join(', ')}, which your plan does not `
        + 'include, so those terms can never match. An absent member means "not in your plan", '
        + 'not "checked, and no".';
    if (action === 'throw') {
        throw new Error(`vpndetection: ${message}`);
    }
    warn(message);
}

// A misconfiguration is the same on every request, so saying so once is a
// warning and saying so a million times is an outage of its own.
function onceEach(sink: (message: string) => void): (message: string) => void {
    const seen = new Set<string>();
    return (message) => {
        if (seen.has(message)) {
            return;
        }
        seen.add(message);
        sink(`[vpndetection] ${message}`);
    };
}
