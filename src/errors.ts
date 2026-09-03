/**
 * Why a request failed.
 *
 * `rate_limited` and `quota_exceeded` both arrive as HTTP 429 and are NOT the
 * same thing. A rate limit is the API protecting itself and carries
 * `Retry-After`; retrying works. A spent quota carries no such header and
 * retrying will not help until the window rolls over or the limit is raised.
 * The header is the only thing that distinguishes them.
 */
export type ErrorKind =
    | 'bad_request'
    | 'unauthorized'
    | 'forbidden'
    | 'rate_limited'
    | 'quota_exceeded'
    | 'server_error'
    | 'network';

export class VPNDetectionError extends Error {
    readonly kind: ErrorKind;
    readonly status?: number;
    readonly retryAfterSeconds?: number;

    constructor(kind: ErrorKind, message: string, status?: number, retryAfterSeconds?: number) {
        super(message);
        this.name = 'VPNDetectionError';
        this.kind = kind;
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    /** Whether retrying this exact request could succeed. */
    get retryable(): boolean {
        return this.kind === 'rate_limited' || this.kind === 'server_error' || this.kind === 'network';
    }
}

export function errorFromResponse(
    status: number, headers: { get(name: string): string | null }, body: unknown,
): VPNDetectionError {
    const message = messageOf(body) ?? `request failed with status ${status}`;
    const retryAfter = parseRetryAfter(headers.get('retry-after'));

    if (status === 429) {
        // Present means transient, absent means an allowance is spent. Nothing
        // else in the response separates the two.
        return retryAfter === undefined
            ? new VPNDetectionError('quota_exceeded', message, status)
            : new VPNDetectionError('rate_limited', message, status, retryAfter);
    }
    if (status === 400) {
        return new VPNDetectionError('bad_request', message, status);
    }
    if (status === 401) {
        return new VPNDetectionError('unauthorized', message, status);
    }
    if (status === 403) {
        return new VPNDetectionError('forbidden', message, status);
    }
    // Any other 4xx is a CLIENT error. Falling through to the server_error
    // default would make it retryable, so a bad dataset id would be retried
    // twice before failing. Only 5xx and transport failures are worth a retry.
    if (status < 500) {
        return new VPNDetectionError('bad_request', message, status);
    }
    return new VPNDetectionError('server_error', message, status);
}

// The two APIs behind this host answer with different envelopes: the lookup
// endpoint uses `error`, the database endpoints use `rc`. Both are read here so
// a caller never has to know which one they hit.
function messageOf(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null) {
        return undefined;
    }
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'string') {
        return b.error;
    }
    if (typeof b.rc === 'string') {
        return b.rc;
    }
    return undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
    if (value === null || value.trim() === '') {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds;
    }
    // The header also permits an HTTP date.
    const when = Date.parse(value);
    if (Number.isNaN(when)) {
        return undefined;
    }
    return Math.max(0, Math.ceil((when - Date.now()) / 1000));
}
