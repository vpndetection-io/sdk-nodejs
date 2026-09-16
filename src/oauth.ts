import type { Client } from './generated/client/index.js';
import {
    oauthDeviceAuthorization, oauthMetadata, oauthRevoke, oauthToken,
} from './generated/sdk.gen.js';
import type { TokenRequest } from './generated/types.gen.js';

import {
    errorFromResponse, OauthError, oauthErrorFrom, OauthExpiredTokenError, VPNDetectionError,
} from './errors.js';
import { asError, deadline, withRetry, type Res } from './transport.js';

/** Per-call overrides for one OAuth request. Anything omitted falls back to the client's setting. */
export interface OauthOptions {
    /** How long one attempt may take before it is abandoned, in milliseconds. */
    timeoutMs?: number;
}

/** What a device sign-in asks for. A member left out is left out of the request, never sent empty. */
export interface DeviceAuthorizationOptions extends OauthOptions {
    /** Space-delimited scopes, sent as given. The server narrows them to what the client may ask for. */
    scope?: string;
    /** The API the tokens are meant for. */
    resource?: string;
}

export interface PollDeviceTokenOptions {
    /** How long EACH request of the poll may take, in milliseconds. Never bounds the poll as a whole. */
    timeoutMs?: number;
    /** Aborting it stops the wait and any request in flight, and the poll rejects with its reason. */
    signal?: AbortSignal;
}

/** The authorization server's discovery document. No call here needs it: each builds on the base URL. */
export interface OauthMetadata {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    device_authorization_endpoint?: string;
    revocation_endpoint?: string;
    scopes_supported?: string[];
    response_types_supported?: string[];
    grant_types_supported?: string[];
    code_challenge_methods_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
    authorization_response_iss_parameter_supported?: boolean;
    service_documentation?: string;
}

/** A started device sign-in. `expires_in` and `interval` are seconds. */
export interface DeviceAuthorization {
    device_code: string;
    /** What the person types in at `verification_uri`. */
    user_code: string;
    verification_uri: string;
    /** `verification_uri` with the code already in it, for a program that can open a browser. */
    verification_uri_complete?: string;
    expires_in: number;
    interval: number;
}

/**
 * What a completed sign-in or a refresh hands back.
 *
 * `apikey_id` is set when the person picked one of their API keys and may still
 * read it back. `apikey`, the key itself, also needs a sign-in rather than a
 * refresh and a key whose secret can be shown again, so `apikey_id` without
 * `apikey` is normal. An empty `scope` is present.
 */
export interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    /** Spent by the refresh that presents it, so keep the one each refresh returns. */
    refresh_token?: string;
    scope?: string;
    apikey_id?: string;
    apikey?: string;
}

/**
 * Signs a person in on their own machine with the OAuth device flow, so a
 * program can be handed one of their API keys instead of asking them to paste
 * it. Reached through `client.oauth`.
 *
 * Every call takes a client ID, issued on request from support@vpndetection.io.
 * None of these requests carries the client's API key, and none needs one.
 */
export class OauthApi {
    // The poll's wait and its deadline, which tests replace together.
    private clock: Clock = { now: () => performance.now(), sleep: sleep };

    constructor(
        private readonly client: Client,
        private readonly retries: number,
        private readonly timeoutMs: number,
    ) {}

    async metadata(options: OauthOptions = {}): Promise<OauthMetadata> {
        return withRetry(this.retries, async () => {
            const res = await deadline(options.timeoutMs ?? this.timeoutMs, (signal) => oauthMetadata({
                client: this.client, signal: signal,
            }));
            return decode(res, METADATA);
        });
    }

    /**
     * Start a device sign-in: show the person `user_code` and `verification_uri`,
     * then hand the answer to `pollDeviceToken`. It consumes nothing, so it is
     * retried like a lookup; a refusal such as `slow_down` is an `OauthError`.
     */
    async deviceAuthorization(
        clientId: string, options: DeviceAuthorizationOptions = {},
    ): Promise<DeviceAuthorization> {
        const body = {
            client_id: clientId,
            scope: options.scope || undefined,
            resource: options.resource || undefined,
        };
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        return withRetry(this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => oauthDeviceAuthorization({
                client: this.client, body: body, signal: signal,
            }));
            return decode(res, DEVICE_AUTHORIZATION);
        });
    }

    /**
     * Ask once whether the person has approved a device sign-in. Until they do,
     * it rejects with an `OauthError` coded `authorization_pending`;
     * `pollDeviceToken` is the loop around it.
     *
     * Never retried: an approved code is spent by the answer carrying the tokens,
     * so a retry after a lost response could only lose them.
     */
    async exchangeDeviceCode(
        clientId: string, deviceCode: string, options: OauthOptions = {},
    ): Promise<TokenResponse> {
        return this.exchange({
            grant_type: DEVICE_CODE_GRANT, device_code: deviceCode, client_id: clientId,
        }, options.timeoutMs);
    }

    /**
     * Trade a refresh token for a new pair. The old one is spent whatever happens
     * next, so this is never retried. A refresh names the key the person picked
     * (`apikey_id`) but never reveals it again (`apikey`).
     */
    async exchangeRefreshToken(
        clientId: string, refreshToken: string, options: OauthOptions = {},
    ): Promise<TokenResponse> {
        return this.exchange({
            grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId,
        }, options.timeoutMs);
    }

    /**
     * End a token. A refresh token ends the whole sign-in and every token it
     * issued, which is how a program signs the machine out; an access token ends
     * only itself. The server answers the same for any token, known or not.
     */
    async revoke(clientId: string, token: string, options: OauthOptions = {}): Promise<void> {
        await withRetry(this.retries, async () => {
            const res = await deadline(options.timeoutMs ?? this.timeoutMs, (signal) => oauthRevoke({
                client: this.client,
                body: { token: token, client_id: clientId },
                // The answer says nothing, so it is read as text and dropped rather than parsed.
                parseAs: 'text',
                signal: signal,
            }));
            throwIfFailed(res);
        });
    }

    /**
     * Wait for the person to approve a device sign-in, and return its tokens.
     *
     * Waits `device.interval` seconds (5 when that is below 1) before EVERY
     * request, the first included, and 5 more for the rest of the call each time
     * the server answers `slow_down`. Ends at the first answer that is neither:
     * a denial rejects with `OauthAccessDeniedError`, a code that ran out with
     * `OauthExpiredTokenError` - as does outliving `device.expires_in`, counted
     * from this call, with no `status` - and any other failure as it came.
     */
    async pollDeviceToken(
        clientId: string, device: DeviceAuthorization, options: PollDeviceTokenOptions = {},
    ): Promise<TokenResponse> {
        let interval = device.interval >= 1 ? device.interval : 5;
        const expires = this.clock.now() + device.expires_in * 1000;
        for (;;) {
            await this.clock.sleep(interval * 1000, options.signal);
            if (this.clock.now() >= expires) {
                throw new OauthExpiredTokenError();
            }
            try {
                return await this.exchange({
                    grant_type: DEVICE_CODE_GRANT, device_code: device.device_code, client_id: clientId,
                }, options.timeoutMs, options.signal);
            } catch (err) {
                if (!(err instanceof OauthError)) {
                    throw err;
                }
                // RFC 8628: slow_down widens the interval for every later request, not just the next.
                if (err.errorCode === 'slow_down') {
                    interval += 5;
                } else if (err.errorCode !== 'authorization_pending') {
                    throw err;
                }
            }
        }
    }

    private async exchange(
        form: TokenRequest, timeoutMs?: number, cancel?: AbortSignal,
    ): Promise<TokenResponse> {
        const res = await deadline(timeoutMs ?? this.timeoutMs, (signal) => oauthToken({
            client: this.client, body: form, signal: signal,
        }), cancel);
        return decode(res, TOKEN_RESPONSE);
    }
}

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface Clock {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

interface Member {
    type: 'string' | 'number' | 'boolean' | 'string[]';
    required?: true;
    /** The name on the wire, where it differs from the one surfaced. */
    wire?: string;
}

const METADATA: Record<keyof OauthMetadata, Member> = {
    issuer: { type: 'string', required: true },
    authorization_endpoint: { type: 'string', required: true },
    token_endpoint: { type: 'string', required: true },
    device_authorization_endpoint: { type: 'string' },
    revocation_endpoint: { type: 'string' },
    scopes_supported: { type: 'string[]' },
    response_types_supported: { type: 'string[]' },
    grant_types_supported: { type: 'string[]' },
    code_challenge_methods_supported: { type: 'string[]' },
    token_endpoint_auth_methods_supported: { type: 'string[]' },
    authorization_response_iss_parameter_supported: { type: 'boolean' },
    service_documentation: { type: 'string' },
};

const DEVICE_AUTHORIZATION: Record<keyof DeviceAuthorization, Member> = {
    device_code: { type: 'string', required: true },
    user_code: { type: 'string', required: true },
    verification_uri: { type: 'string', required: true },
    verification_uri_complete: { type: 'string' },
    expires_in: { type: 'number', required: true },
    interval: { type: 'number', required: true },
};

const TOKEN_RESPONSE: Record<keyof TokenResponse, Member> = {
    access_token: { type: 'string', required: true },
    token_type: { type: 'string', required: true },
    expires_in: { type: 'number', required: true },
    refresh_token: { type: 'string' },
    scope: { type: 'string' },
    apikey_id: { type: 'string', wire: 'mslm:apikey_id' },
    apikey: { type: 'string', wire: 'mslm:apikey' },
};

// Only the declared members are copied, on PRESENCE, so an absent one stays
// absent and an empty `scope` stays present. Anything else the server sends is
// dropped rather than surfaced untyped.
function decode<T>(res: Res, members: Record<keyof T, Member>): T {
    const status = throwIfFailed(res).status;
    if (res.error !== undefined) {
        // A 2xx the generated client could not parse, which reports it here.
        throw asError(res.error);
    }
    const body = res.data;
    if (!isObject(body)) {
        throw new VPNDetectionError('server_error', 'the answer was not a JSON object', status);
    }
    const out: Record<string, unknown> = {};
    for (const [name, member] of Object.entries<Member>(members)) {
        const wire = member.wire ?? name;
        const value = body[wire];
        if (value === undefined || value === null) {
            if (member.required) {
                throw new VPNDetectionError('server_error', `the answer carried no ${wire}`, status);
            }
            continue;
        }
        if (!hasType(value, member.type)) {
            throw new VPNDetectionError(
                'server_error', `the answer's ${wire} is not a ${member.type}`, status,
            );
        }
        out[name] = value;
    }
    return out as T;
}

// Only a 4xx whose body is a JSON object with a STRING `error` is an OAuth
// refusal. Every 5xx, whatever it says, is the server failing, and is retried
// wherever the operation retries.
function throwIfFailed(res: Res): Response {
    if (res.response === undefined) {
        throw new VPNDetectionError('network', 'no response from the API');
    }
    const { status, ok, headers } = res.response;
    if (ok) {
        return res.response;
    }
    const body = res.error;
    if (status >= 400 && status < 500 && isObject(body) && typeof body.error === 'string') {
        const description = typeof body.error_description === 'string' ? body.error_description : undefined;
        throw oauthErrorFrom(body.error, description, status);
    }
    throw errorFromResponse(status, headers, body);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasType(value: unknown, type: Member['type']): boolean {
    if (type === 'string[]') {
        return Array.isArray(value) && value.every((item) => typeof item === 'string');
    }
    return typeof value === type;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
