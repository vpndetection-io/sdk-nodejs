import type {
    ClassDetail, LookupResponse, ProxyDetail, VpnDetail,
} from './generated/types.gen.js';

export type { ClassDetail, ProxyDetail, VpnDetail, LookupResponse };

/**
 * What a lookup answers.
 *
 * An **optional** member is one your plan does not include. It never means "we
 * could not check", so `undefined` and `false` are genuinely different answers:
 * `undefined` is "not in your plan", `false` is "checked, and no". Use
 * `?? false` when you only care whether the address is flagged.
 *
 * A detail object that is present but empty (`{}`) means the flag above it is
 * false. A populated one always carries every one of its keys.
 */
export interface Result {
    /** The address that was looked up, normalized. */
    ip: string;
    /** Whether the address is VPN infrastructure. Every plan includes this. */
    isVpn: boolean;
    /** Set when this answer was computed locally rather than served. */
    isBogon: boolean;

    isHosting?: boolean;
    isRelay?: boolean;
    isTor?: boolean;
    isCdn?: boolean;
    isResproxy?: boolean;
    isDcproxy?: boolean;
    isMobproxy?: boolean;

    vpn?: VpnDetail;
    hosting?: ClassDetail;
    relay?: ClassDetail;
    tor?: ClassDetail;
    cdn?: ClassDetail;
    resproxy?: ProxyDetail;
    dcproxy?: ProxyDetail;
    mobproxy?: ProxyDetail;

    /** The response exactly as it came off the wire, with its original names. */
    raw: LookupResponse;
}

// The one place the wire's snake_case becomes idiomatic camelCase. Every
// assignment is conditional on the key being PRESENT rather than truthy, so a
// plan that includes a field and answers `false` keeps it, and a plan that does
// not include it stays undefined.
export function toResult(body: LookupResponse): Result {
    const r: Result = {
        ip: body.ip,
        isVpn: body.is_vpn,
        isBogon: false,
        raw: body,
    };
    copyFlag(body, r, 'is_hosting', 'isHosting');
    copyFlag(body, r, 'is_relay', 'isRelay');
    copyFlag(body, r, 'is_tor', 'isTor');
    copyFlag(body, r, 'is_cdn', 'isCdn');
    copyFlag(body, r, 'is_resproxy', 'isResproxy');
    copyFlag(body, r, 'is_dcproxy', 'isDcproxy');
    copyFlag(body, r, 'is_mobproxy', 'isMobproxy');
    copyDetail(body, r, 'vpn', 'vpn');
    copyDetail(body, r, 'hosting', 'hosting');
    copyDetail(body, r, 'relay', 'relay');
    copyDetail(body, r, 'tor', 'tor');
    copyDetail(body, r, 'cdn', 'cdn');
    copyDetail(body, r, 'resproxy', 'resproxy');
    copyDetail(body, r, 'dcproxy', 'dcproxy');
    copyDetail(body, r, 'mobproxy', 'mobproxy');
    return r;
}

function copyFlag(
    body: LookupResponse, out: Result,
    from: keyof LookupResponse, to: 'isHosting' | 'isRelay' | 'isTor' | 'isCdn'
        | 'isResproxy' | 'isDcproxy' | 'isMobproxy',
) {
    if (from in body && body[from] !== undefined) {
        out[to] = body[from] as boolean;
    }
}

function copyDetail(
    body: LookupResponse, out: Result,
    from: keyof LookupResponse,
    to: 'vpn' | 'hosting' | 'relay' | 'tor' | 'cdn' | 'resproxy' | 'dcproxy' | 'mobproxy',
) {
    if (from in body && body[from] !== undefined) {
        out[to] = body[from] as never;
    }
}
