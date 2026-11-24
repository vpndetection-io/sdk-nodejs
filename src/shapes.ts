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
export const ASN_MEMBERS = ['asn', 'name', 'domain', 'type', 'prefix', 'country', 'rpki_status'] as const;
export const COMPANY_MEMBERS = ['name', 'domain'] as const;
export const ABUSE_CONTACT_MEMBERS = ['email'] as const;
export const WEB_DETAIL_MEMBERS = [
    'port', 'tls_ok', 'session_ok', 'status_code', 'server', 'location', 'title', 'cert_subject_cn',
    'cert_subject_o', 'cert_issuer_dn', 'cert_browser_trusted', 'tls_version', 'first_seen', 'last_seen',
] as const;
export const USER_AGENT_MEMBERS = ['agent', 'kind', 'verdict'] as const;
export const BATCH_MEMBERS = ['results', 'errors'] as const;
export const BATCH_ERROR_MEMBERS = ['status', 'error'] as const;
export const ENTITLEMENT_MEMBERS = ['org_id', 'apikey', 'plan', 'usage'] as const;
export const ENTITLEMENT_APIKEY_MEMBERS = ['id', 'allowed_cidrs'] as const;
export const ENTITLEMENT_PLAN_MEMBERS = ['key', 'name', 'tier'] as const;
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
//
// A `date` or `date-time` member is RFC 3339's, on a day that exists. Through
// 5.10.1 one was checked as a string alone, so `tomorrow`, 30 February, 24:00, a
// time with no offset, `+05`, no seconds and a date alone where a date-time is due
// all came back as served (measured 2026-10-26). The test holds these kinds to the
// spec's `format`.
type Kind = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'date' | 'date-time';

export const LOOKUP_TYPES: Record<string, Kind> = {
    ip: 'string', is_bogon: 'boolean', is_vpn: 'boolean', is_hosting: 'boolean', is_relay: 'boolean', is_tor: 'boolean',
    is_cdn: 'boolean', is_resproxy: 'boolean', is_dcproxy: 'boolean', is_mobproxy: 'boolean',
    is_pubproxy: 'boolean', is_anycast: 'boolean', is_carrier: 'boolean', is_satellite: 'boolean', is_ssh: 'boolean',
    is_smtp: 'boolean', is_web: 'boolean', is_dns_resolver: 'boolean', is_bittorrent: 'boolean', vpn: 'object',
    hosting: 'object', relay: 'object', tor: 'object', cdn: 'object', resproxy: 'object', dcproxy: 'object',
    mobproxy: 'object', pubproxy: 'object', carrier: 'object', satellite: 'object', ssh: 'object', smtp: 'object',
    web: 'array', dns_resolver: 'object', bittorrent: 'object', location: 'object', asn: 'object',
    company: 'object', hostname: 'string', abuse: 'object', trial_expired: 'boolean', cap_reached: 'boolean',
    is_bot: 'boolean', bot: 'object', user_agent: 'object',
};
export const VPN_DETAIL_TYPES: Record<string, Kind> = {
    provider: 'string', provider_name: 'string', last_seen: 'date', confidence: 'string', method: 'string',
};
export const CLASS_DETAIL_TYPES: Record<string, Kind> = {
    provider: 'string', provider_name: 'string', confidence: 'string', last_seen: 'date',
};
export const PROXY_DETAIL_TYPES: Record<string, Kind> = {
    provider: 'string', provider_name: 'string', first_seen: 'date', last_seen: 'date', hits: 'integer',
    hits_days_pct: 'integer', providers_num: 'integer',
};
export const PUBPROXY_DETAIL_TYPES: Record<string, Kind> = {
    entry: 'boolean', exit: 'boolean', protocols: 'array', num_ports: 'integer', num_proxies: 'integer',
    last_seen: 'date', last_usable: 'string',
};
export const BOT_DETAIL_TYPES: Record<string, Kind> = {
    provider: 'string', provider_name: 'string', agents: 'array', categories: 'array', verified: 'boolean',
    identity: 'string', verified_by: 'string', confidence: 'string', first_seen: 'date', last_seen: 'date',
};
// `verdict` is read as any string, so a verdict the API adds comes back as served.
export const USER_AGENT_TYPES: Record<string, Kind> = { agent: 'string', kind: 'string', verdict: 'string' };
export const CARRIER_DETAIL_TYPES: Record<string, Kind> = {
    name: 'string', mcc: 'string', mnc: 'string', country: 'string', confidence: 'string',
};
export const SATELLITE_DETAIL_TYPES: Record<string, Kind> = {
    provider: 'string', provider_name: 'string', orbit: 'string', segment: 'string', country: 'string',
    asn: 'integer', confidence: 'string',
};
export const SSH_DETAIL_TYPES: Record<string, Kind> = {
    port: 'integer', banner: 'string', host_key_fp: 'string', session_ok: 'boolean', first_seen: 'date',
    last_seen: 'date',
};
export const SMTP_DETAIL_TYPES: Record<string, Kind> = {
    port: 'integer', banner: 'string', session_ok: 'boolean', first_seen: 'date', last_seen: 'date',
};
export const WEB_DETAIL_TYPES: Record<string, Kind> = {
    port: 'integer', tls_ok: 'boolean', session_ok: 'boolean', status_code: 'integer', server: 'string',
    location: 'string', title: 'string', cert_subject_cn: 'string', cert_subject_o: 'string',
    cert_issuer_dn: 'string', cert_browser_trusted: 'boolean', tls_version: 'string', first_seen: 'date',
    last_seen: 'date',
};
export const DNS_RESOLVER_DETAIL_TYPES: Record<string, Kind> = {
    port: 'integer', recursion_available: 'boolean', rcode: 'integer', answer_correct: 'boolean',
    first_seen: 'date', last_seen: 'date',
};
export const BITTORRENT_DETAIL_TYPES: Record<string, Kind> = {
    verified: 'boolean', id_matches_ip: 'boolean', first_seen: 'date', last_seen: 'date',
    last_reachable: 'string', days_seen: 'integer', num_ports: 'integer', peak_num_ports: 'integer',
    indexer: 'boolean', clients: 'array',
};
export const LOCATION_TYPES: Record<string, Kind> = {
    ...Object.fromEntries(LOCATION_MEMBERS.map((m) => [m, 'string'] as const)),
    region: 'string', region_code: 'string', city: 'string', postal_code: 'string', latitude: 'number',
    longitude: 'number', accuracy_radius: 'integer', geoname_id: 'string', dma_code: 'string',
    last_changed: 'string',
};
export const ASN_TYPES: Record<string, Kind> = {
    asn: 'integer', name: 'string', domain: 'string', type: 'string', prefix: 'string', country: 'string',
    rpki_status: 'string',
};
export const COMPANY_TYPES: Record<string, Kind> = {
    name: 'string', domain: 'string', type: 'string', country: 'string',
};
export const ABUSE_CONTACT_TYPES: Record<string, Kind> = {
    email: 'string', name: 'string', phone: 'string', address: 'string', country: 'string', network: 'string',
    validated: 'boolean', unvalidated_since: 'string',
};
export const BATCH_ERROR_TYPES: Record<string, Kind> = { status: 'integer', error: 'string' };
export const ENTITLEMENT_TYPES: Record<string, Kind> = {
    org_id: 'string', apikey: 'object', plan: 'object', usage: 'object',
};
export const ENTITLEMENT_APIKEY_TYPES: Record<string, Kind> = { id: 'string', expires: 'date-time', allowed_cidrs: 'array' };
export const ENTITLEMENT_PLAN_TYPES: Record<string, Kind> = { key: 'string', name: 'string', tier: 'string' };
export const ENTITLEMENT_USAGE_TYPES: Record<string, Kind> = {
    requests: 'integer', quota: 'integer', hard_limit: 'integer', window_start: 'date-time', window_end: 'date-time',
};
export const DATABASE_TYPES: Record<string, Kind> = {
    base: 'string', name: 'string', summary: 'string', license_type: 'string', starts: 'date-time',
    expires: 'date-time', renews_at: 'date-time', notice_due_at: 'date-time', in_term: 'boolean', standing: 'string',
    open: 'boolean', versions: 'array',
};
export const DATABASE_VERSION_TYPES: Record<string, Kind> = {
    id: 'string', version: 'integer', summary: 'string', formats: 'array', sample_formats: 'array',
};
export const DATABASE_FORMAT_SIZE_TYPES: Record<string, Kind> = { format: 'string', bytes: 'integer' };
export const DATABASE_METADATA_TYPES: Record<string, Kind> = {
    id: 'string', update_freq: 'string', updated: 'date', entries: 'integer', schema: 'object',
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
    created: 'date-time',
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown, kind: Kind): boolean {
    switch (kind) {
        case 'string': return typeof value === 'string';
        case 'integer': return Number.isInteger(value);
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'boolean': return typeof value === 'boolean';
        case 'object': return isObject(value);
        case 'array': return Array.isArray(value);
        case 'date': return typeof value === 'string' && isFullDate(value);
        case 'date-time': return typeof value === 'string' && isDateTime(value);
    }
}

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** RFC 3339's `full-date`, naming a day its month has. */
function isFullDate(value: string): boolean {
    const m = FULL_DATE.exec(value);
    return m !== null && isDay(m[1]!, m[2]!, m[3]!);
}

/**
 * RFC 3339's `date-time`, its lowercase `t` and `z` included, with an hour below 24,
 * a minute and a second below 60 and an offset of at most 23:59.
 */
function isDateTime(value: string): boolean {
    const m = DATE_TIME.exec(value);
    return m !== null && isDay(m[1]!, m[2]!, m[3]!) && Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60
        && (m[7] === undefined || (Number(m[7]) < 24 && Number(m[8]) < 60));
}

// setUTCFullYear rather than Date.UTC, which reads a year below 100 as 19xx.
function isDay(year: string, month: string, day: string): boolean {
    const date = new Date(0);
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1
        && date.getUTCDate() === Number(day);
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

function lists(value: unknown, member: string, valid: (entry: unknown) => boolean): boolean {
    return optional((value as Record<string, unknown>)[member], (list) => every(list, valid));
}

const DETAILS: [string, Record<string, Kind>][] = [
    ['vpn', VPN_DETAIL_TYPES], ['hosting', CLASS_DETAIL_TYPES], ['relay', CLASS_DETAIL_TYPES],
    ['tor', CLASS_DETAIL_TYPES], ['cdn', CLASS_DETAIL_TYPES], ['resproxy', PROXY_DETAIL_TYPES],
    ['dcproxy', PROXY_DETAIL_TYPES], ['mobproxy', PROXY_DETAIL_TYPES], ['pubproxy', PUBPROXY_DETAIL_TYPES],
    ['carrier', CARRIER_DETAIL_TYPES], ['satellite', SATELLITE_DETAIL_TYPES], ['ssh', SSH_DETAIL_TYPES],
    ['smtp', SMTP_DETAIL_TYPES], ['dns_resolver', DNS_RESOLVER_DETAIL_TYPES],
    ['bittorrent', BITTORRENT_DETAIL_TYPES], ['bot', BOT_DETAIL_TYPES],
];

const SHARED: [string, readonly string[], Record<string, Kind>][] = [
    ['location', LOCATION_MEMBERS, LOCATION_TYPES],
    ['asn', ASN_MEMBERS, ASN_TYPES],
    ['company', COMPANY_MEMBERS, COMPANY_TYPES],
    ['abuse', ABUSE_CONTACT_MEMBERS, ABUSE_CONTACT_TYPES],
];

export function isLookup(data: unknown): boolean {
    return typed(data, LOOKUP_MEMBERS, LOOKUP_TYPES)
        && DETAILS.every(([member, types]) => optional(data[member], (detail) => typed(detail, [], types)))
        && optional(data['pubproxy'], (pubproxy) => lists(pubproxy, 'protocols', isString))
        && optional(data['bittorrent'], (bittorrent) => lists(bittorrent, 'clients', isString))
        && optional(data['bot'], (bot) => lists(bot, 'agents', isString) && lists(bot, 'categories', isString))
        && optional(data['web'], (web) => every(web, (row) => typed(row, WEB_DETAIL_MEMBERS, WEB_DETAIL_TYPES)))
        && optional(data['user_agent'], (verdict) => typed(verdict, USER_AGENT_MEMBERS, USER_AGENT_TYPES))
        && SHARED.every(([member, required, types]) => optional(data[member], (o) => typed(o, required, types)));
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
