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
 * Bound one attempt, and report an expiry as our own error rather than the
 * runtime's `TimeoutError`, whose message says nothing about which call gave up.
 *
 * The signal is built per call, so a retried request gets a fresh budget - the
 * same per-attempt semantics the Go and Python clients have. Aborting `cancel`
 * ends the attempt at once, rejecting with its reason.
 */
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
// and the retry decision both key off the same field.
export async function withRetry<T>(retries: number, fn: () => Promise<T>): Promise<T> {
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
