import type {
    ClassDetail, Database, DatabaseFormat, LookupResponse, ProxyDetail, Standing, VpnDetail,
} from './generated/types.gen.js';

export type { ClassDetail, ProxyDetail, VpnDetail, LookupResponse };

// The runtime halves of the three closed vocabularies the API publishes, for a
// caller that wants to validate or enumerate rather than switch. The generated
// names are TYPES and are erased at compile time, so a JS caller - or anything
// taking one of these from a CLI flag, a form field or a model - has nothing to
// check against without them.
//
// Each is TYPED by the generated union, so a value the spec does not define
// will not compile; that a value is MISSING is what `conformance.test.mjs` pins
// against the pinned spec, since a subset would type-check happily.
export const DATABASE_FORMATS: readonly DatabaseFormat[] = ['csvgz', 'mmdb'];

export const STANDINGS: readonly Standing[] = ['expired', 'licensed', 'unlicensed'];

export const LICENSE_TYPES: readonly NonNullable<Database['license_type']>[] = [
    'evaluation', 'standard', 'redistribute',
];

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
