// The members each answer must carry before the client hands it back: every one
// the spec requires and never sends as null, checked against the real API. The
// test reads them against the generated types, so a member the spec adds fails
// the suite until it is here.

import { hasMembers } from './transport.js';

export const LOOKUP_MEMBERS = ['ip', 'is_vpn'] as const;
export const LOCATION_MEMBERS = [
    'continent', 'continent_name', 'country', 'country_name', 'timezone', 'currency_code', 'currency_name',
    'currency_symbol', 'flag_emoji', 'flag_unicode',
] as const;
export const ASN_MEMBERS = ['asn', 'name', 'domain', 'type', 'prefix'] as const;
export const BATCH_MEMBERS = ['results', 'errors'] as const;
export const BATCH_ERROR_MEMBERS = ['status', 'error'] as const;
export const ENTITLEMENT_MEMBERS = ['org_id', 'apikey', 'plan', 'usage'] as const;
export const ENTITLEMENT_APIKEY_MEMBERS = ['id', 'allowed_cidrs'] as const;
export const ENTITLEMENT_PLAN_MEMBERS = ['key', 'tier'] as const;
export const ENTITLEMENT_USAGE_MEMBERS = ['requests', 'quota', 'window_start', 'window_end'] as const;
export const DATABASE_MEMBERS = ['base', 'name', 'summary', 'in_term', 'standing', 'open', 'versions'] as const;
export const DATABASE_VERSION_MEMBERS = ['id', 'version', 'formats'] as const;
export const DATABASE_FORMAT_SIZE_MEMBERS = ['format'] as const;
export const DATABASE_METADATA_MEMBERS = ['id', 'updated', 'entries', 'schema'] as const;
export const DATABASE_METADATA_COLUMN_MEMBERS = ['name', 'type'] as const;
export const DB_CHECKSUMS_MEMBERS = ['md5', 'sha1', 'sha256', 'sha512'] as const;
// `checksums` hands back the digests alone, so through 5.10.0 nothing read `id` or
// `format`, and an answer without either came back as whole (measured 2026-10-23).
export const CHECKSUM_ANSWER_MEMBERS = ['id', 'format', 'checksums'] as const;
export const DOWNLOAD_MEMBERS = ['dataset_id', 'format', 'outcome', 'sample', 'open', 'created'] as const;

// Every member's type, the nullable and optional ones included. Through 5.10.0
// only presence was checked, so a version served as "3", a lookup's `dcproxy.hits`
// as "3" or an entitlement's `requests` as "5" came back as that string where a
// number is promised (measured 2026-10-23). A member the spec requires and never
// sends as null may not be null; any other may be null or absent, and is
// otherwise of its type. The test holds each table to its generated type.
type Kind = 'string' | 'integer' | 'boolean' | 'object' | 'array';

export const LOOKUP_TYPES: Record<string, Kind> = {
    ip: 'string', is_vpn: 'boolean', is_hosting: 'boolean', is_relay: 'boolean', is_tor: 'boolean',
    is_cdn: 'boolean', is_resproxy: 'boolean', is_dcproxy: 'boolean', is_mobproxy: 'boolean',
    is_pubproxy: 'boolean', vpn: 'object', hosting: 'object', relay: 'object', tor: 'object', cdn: 'object',
    resproxy: 'object', dcproxy: 'object', mobproxy: 'object', pubproxy: 'object', location: 'object',
    asn: 'object',
};
export const VPN_DETAIL_TYPES: Record<string, Kind> = {
    provider: 'string', last_seen: 'string', confidence: 'string', method: 'string',
};
export const CLASS_DETAIL_TYPES: Record<string, Kind> = { provider: 'string', confidence: 'string', last_seen: 'string' };
export const PROXY_DETAIL_TYPES: Record<string, Kind> = {
    provider: 'string', first_seen: 'string', last_seen: 'string', hits: 'integer', hits_days_pct: 'integer',
    providers_num: 'integer',
};
export const PUBPROXY_DETAIL_TYPES: Record<string, Kind> = {
    entry: 'boolean', exit: 'boolean', protocols: 'array', num_ports: 'integer', num_proxies: 'integer',
    last_seen: 'string', last_usable: 'string',
};
export const LOCATION_TYPES: Record<string, Kind> = Object.fromEntries(
    LOCATION_MEMBERS.map((m) => [m, 'string'] as const),
);
export const ASN_TYPES: Record<string, Kind> = {
    asn: 'integer', name: 'string', domain: 'string', type: 'string', prefix: 'string',
};
export const BATCH_ERROR_TYPES: Record<string, Kind> = { status: 'integer', error: 'string' };
export const ENTITLEMENT_TYPES: Record<string, Kind> = {
    org_id: 'string', apikey: 'object', plan: 'object', usage: 'object',
};
export const ENTITLEMENT_APIKEY_TYPES: Record<string, Kind> = { id: 'string', expires: 'string', allowed_cidrs: 'array' };
export const ENTITLEMENT_PLAN_TYPES: Record<string, Kind> = { key: 'string', tier: 'string' };
export const ENTITLEMENT_USAGE_TYPES: Record<string, Kind> = {
    requests: 'integer', quota: 'integer', hard_limit: 'integer', window_start: 'string', window_end: 'string',
};
export const DATABASE_TYPES: Record<string, Kind> = {
    base: 'string', name: 'string', summary: 'string', license_type: 'string', starts: 'string',
    expires: 'string', renews_at: 'string', notice_due_at: 'string', in_term: 'boolean', standing: 'string',
    open: 'boolean', versions: 'array',
};
export const DATABASE_VERSION_TYPES: Record<string, Kind> = {
    id: 'string', version: 'integer', summary: 'string', formats: 'array', sample_formats: 'array',
};
export const DATABASE_FORMAT_SIZE_TYPES: Record<string, Kind> = { format: 'string', bytes: 'integer' };
export const DATABASE_METADATA_TYPES: Record<string, Kind> = {
    id: 'string', update_freq: 'string', updated: 'string', entries: 'integer', schema: 'object',
    sample: 'object', size: 'object', sample_size: 'object', sample_entries: 'integer',
};
export const DATABASE_METADATA_COLUMN_TYPES: Record<string, Kind> = {
    name: 'string', type: 'string', description: 'string',
};
export const DB_CHECKSUMS_TYPES: Record<string, Kind> = {
    md5: 'string', sha1: 'string', sha256: 'string', sha512: 'string',
};
export const DOWNLOAD_TYPES: Record<string, Kind> = {
    dataset_id: 'string', format: 'string', outcome: 'string', sample: 'boolean', open: 'boolean',
    bytes: 'integer', http_status: 'integer', apikey_id: 'string', client_ip: 'string', user_agent: 'string',
    created: 'string',
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown, kind: Kind): boolean {
    switch (kind) {
        case 'string': return typeof value === 'string';
        case 'integer': return Number.isInteger(value);
        case 'boolean': return typeof value === 'boolean';
        case 'object': return isObject(value);
        case 'array': return Array.isArray(value);
    }
}

function typed(value: unknown, required: readonly string[], types: Record<string, Kind>): value is Record<string, unknown> {
    return hasMembers(value, required) && Object.entries(types).every(([member, kind]) => {
        const v = value[member];
        return v === undefined || v === null ? !required.includes(member) : isKind(v, kind);
    });
}

function every(value: unknown, valid: (entry: unknown) => boolean): boolean {
    return Array.isArray(value) && value.every(valid);
}

function isString(value: unknown): boolean {
    return typeof value === 'string';
}

function values(value: unknown, valid: (entry: unknown) => boolean): boolean {
    return isObject(value) && Object.values(value).every(valid);
}

/** An optional member: absent or null, or valid. */
function optional(value: unknown, valid: (value: unknown) => boolean): boolean {
    return value === undefined || value === null || valid(value);
}

const DETAILS: [string, Record<string, Kind>][] = [
    ['vpn', VPN_DETAIL_TYPES], ['hosting', CLASS_DETAIL_TYPES], ['relay', CLASS_DETAIL_TYPES],
    ['tor', CLASS_DETAIL_TYPES], ['cdn', CLASS_DETAIL_TYPES], ['resproxy', PROXY_DETAIL_TYPES],
    ['dcproxy', PROXY_DETAIL_TYPES], ['mobproxy', PROXY_DETAIL_TYPES], ['pubproxy', PUBPROXY_DETAIL_TYPES],
];

export function isLookup(data: unknown): boolean {
    return typed(data, LOOKUP_MEMBERS, LOOKUP_TYPES)
        && DETAILS.every(([member, types]) => optional(data[member], (detail) => typed(detail, [], types)))
        && optional((data['pubproxy'] as Record<string, unknown> | undefined)?.['protocols'], (p) => every(p, isString))
        && optional(data['location'], (location) => typed(location, LOCATION_MEMBERS, LOCATION_TYPES))
        && optional(data['asn'], (asn) => typed(asn, ASN_MEMBERS, ASN_TYPES));
}

/** Both maps present. An entry in either is judged on its own, as that address's answer. */
export function isBatch(data: unknown): boolean {
    return hasMembers(data, BATCH_MEMBERS) && isObject(data['results']) && isObject(data['errors']);
}

export function isBatchError(entry: unknown): boolean {
    return typed(entry, BATCH_ERROR_MEMBERS, BATCH_ERROR_TYPES);
}

export function isEntitlement(data: unknown): boolean {
    return typed(data, ENTITLEMENT_MEMBERS, ENTITLEMENT_TYPES)
        && typed(data['apikey'], ENTITLEMENT_APIKEY_MEMBERS, ENTITLEMENT_APIKEY_TYPES)
        && every((data['apikey'] as Record<string, unknown>)['allowed_cidrs'], isString)
        && typed(data['plan'], ENTITLEMENT_PLAN_MEMBERS, ENTITLEMENT_PLAN_TYPES)
        && typed(data['usage'], ENTITLEMENT_USAGE_MEMBERS, ENTITLEMENT_USAGE_TYPES);
}

function isVersion(version: unknown): boolean {
    return typed(version, DATABASE_VERSION_MEMBERS, DATABASE_VERSION_TYPES)
        && every(version['formats'], (f) => typed(f, DATABASE_FORMAT_SIZE_MEMBERS, DATABASE_FORMAT_SIZE_TYPES))
        && optional(version['sample_formats'], (formats) => every(formats, isString));
}

function isDatabase(entry: unknown): boolean {
    return typed(entry, DATABASE_MEMBERS, DATABASE_TYPES) && every(entry['versions'], isVersion);
}

export function isDatabaseList(data: unknown): boolean {
    return hasMembers(data, ['databases']) && every(data['databases'], isDatabase);
}

export function isDatabaseMetadata(data: unknown): boolean {
    return typed(data, DATABASE_METADATA_MEMBERS, DATABASE_METADATA_TYPES)
        && values(data['schema'], (columns) => every(columns, (c) => typed(
            c, DATABASE_METADATA_COLUMN_MEMBERS, DATABASE_METADATA_COLUMN_TYPES,
        )))
        && optional(data['size'], (size) => values(size, Number.isInteger))
        && optional(data['sample'], (sample) => values(sample, (rows) => every(rows, isObject)))
        && optional(data['sample_size'], (size) => values(size, Number.isInteger));
}

export function isChecksumsResponse(data: unknown): boolean {
    return typed(data, CHECKSUM_ANSWER_MEMBERS, { id: 'string', format: 'string', checksums: 'object' })
        && typed(data['checksums'], DB_CHECKSUMS_MEMBERS, DB_CHECKSUMS_TYPES);
}

export function isDownloadList(data: unknown): boolean {
    return hasMembers(data, ['downloads'])
        && every(data['downloads'], (entry) => typed(entry, DOWNLOAD_MEMBERS, DOWNLOAD_TYPES));
}
