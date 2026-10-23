import pRetry from 'p-retry';

import { errorFromResponse, VPNDetectionError } from './errors.js';

// The generated client puts a non-2xx body on `error` rather than `data`, and
// types `response` as optional because a transport failure produces neither.
export interface Res { data?: unknown, error?: unknown, response?: Response }

export function unwrap<T>(res: Res): T {
    if (res.response === undefined) {
        throw new VPNDetectionError('network', 'no response from the API');
    }
    if (!res.response.ok) {
        throw errorFromResponse(res.response.status, res.response.headers, res.error ?? res.data);
    }
    return res.data as T;
}

/**
 * A 2xx the call cannot read as its answer: a proxy's HTML page, a cut-off,
 * empty or non-object body, or an object without what the call returns. The
 * server's fault, so a retried `server_error` carrying the status. The
 * generated client handed each back as data, so `lookup` answered a Result
 * holding nothing for `{}`, `list` answered `undefined`, `metadata` the page
 * itself, and a batch threw a raw TypeError (5.5.1, measured 2026-10-12).
 */
export function readable<T>(res: Res, valid: (data: unknown) => boolean): T {
    const data = unwrap<unknown>(res);
    if (!valid(data)) {
        const status = res.response!.status;
        throw new VPNDetectionError('server_error', `unreadable answer from the API, status ${status}`, status);
    }
    return data as T;
}

/** An object holding every member named, none of them missing. */
export function hasMembers(value: unknown, members: readonly string[]): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && members.every((member) => (value as Record<string, unknown>)[member] !== undefined);
}

/**
 * Bound one attempt, and report an expiry as our own error rather than the
 * runtime's `TimeoutError`, whose message says nothing about which call gave up.
 *
 * The signal is built per call, so a retried request gets a fresh budget - the
 * same per-attempt semantics the Go and Python clients have. Aborting `cancel`
 * ends the attempt at once, rejecting with its reason.
 */
// The longest delay setTimeout runs as asked. It runs anything longer, and
// anything that is not a positive number, as 1 ms.
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Refuses a timeout no attempt can meet where it is set, on the client or the
 * call, rather than failing every call as a timeout 1 ms in.
 */
export function checkTimeout(timeoutMs: number | undefined): number | undefined {
    if (timeoutMs !== undefined
        && !(typeof timeoutMs === 'number' && timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS)) {
        throw new VPNDetectionError(
            'bad_request', `timeoutMs must be from 1 to ${MAX_TIMEOUT_MS} milliseconds, got ${String(timeoutMs)}`,
        );
    }
    return timeoutMs;
}

/**
 * A retry count p-retry can run, refused where it is set, on the client or the
 * call: through 5.10.0 a negative, NaN or non-number failed every call with
 * p-retry's own TypeError as a `network` error, and a fraction ended a failing
 * call as one too (measured 2026-10-23). `Infinity` is p-retry's own unbounded
 * count.
 */
export function checkRetries(retries: number | null | undefined): number | undefined {
    // Unset, as `??` has always read a null.
    if (retries === undefined || retries === null) {
        return undefined;
    }
    if (!(typeof retries === 'number' && retries >= 0 && (Number.isInteger(retries) || retries === Infinity))) {
        throw new VPNDetectionError('bad_request', `retries must be a whole number from 0, got ${String(retries)}`);
    }
    return retries;
}

export async function deadline<T>(
    timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>, cancel?: AbortSignal,
): Promise<T> {
    cancel?.throwIfAborted();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stop: (() => void) | undefined;
    // Raced, not left to the signal alone: aborting releases the socket, but only
    // a transport that HONORS the signal then settles, and a substituted `fetch`
    // need not. Clearing the timer stops the losing side rejecting into nothing.
    const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new VPNDetectionError('network', `request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (cancel !== undefined) {
            stop = () => {
                controller.abort(cancel.reason);
                reject(cancel.reason);
            };
            cancel.addEventListener('abort', stop, { once: true });
        }
    });
    try {
        return await Promise.race([fn(controller.signal), expiry]);
    } finally {
        clearTimeout(timer!);
        if (stop !== undefined) {
            cancel?.removeEventListener('abort', stop);
        }
    }
}

// p-retry owns the backoff schedule; the extra sleep here is what honors a
// server-supplied Retry-After, which p-retry has no way to know about. A 429
// carrying that header is the only 429 worth retrying, which is why the wait
// and the retry decision both key off the same field. One past what setTimeout
// runs as asked is waited out on the backoff alone, still a throttle.
export async function withRetry<T>(retries: number, fn: () => Promise<T>): Promise<T> {
    try {
        return await pRetry(fn, {
            retries: retries,
            shouldRetry: ({ error }) => !(error instanceof VPNDetectionError) || error.retryable,
            onFailedAttempt: async ({ error, retriesLeft }) => {
                // p-retry runs this hook before it checks retriesLeft, so with no
                // retry left a wait here would only delay the failure.
                if (retriesLeft <= 0) {
                    return;
                }
                const seconds = error instanceof VPNDetectionError ? error.retryAfterSeconds : undefined;
                if (seconds !== undefined && seconds > 0 && seconds * 1000 <= MAX_TIMEOUT_MS) {
                    await new Promise((r) => setTimeout(r, seconds * 1000));
                }
            },
        });
    } catch (err) {
        throw asError(err);
    }
}

export function asError(err: unknown): VPNDetectionError {
    if (err instanceof VPNDetectionError) {
        return err;
    }
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof VPNDetectionError) {
        return cause;
    }
    return new VPNDetectionError('network', err instanceof Error ? err.message : String(err));
}
