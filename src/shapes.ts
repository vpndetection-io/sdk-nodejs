// The members each answer must carry before the client hands it back: every one
// the spec requires and never sends as null, checked against the real API. The
// test reads them against the generated types, so a member the spec adds fails
// the suite until it is here.

import { hasMembers } from './transport.js';

export const LOOKUP_MEMBERS = ['ip', 'is_vpn'] as const;
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
export const DB_CHECKSUMS_MEMBERS = ['md5', 'sha1', 'sha256', 'sha512'] as const;
export const DOWNLOAD_MEMBERS = ['dataset_id', 'format', 'outcome', 'sample', 'open', 'created'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function every(value: unknown, valid: (entry: unknown) => boolean): boolean {
    return Array.isArray(value) && value.every(valid);
}

export function isLookup(data: unknown): boolean {
    return hasMembers(data, LOOKUP_MEMBERS) && typeof data['ip'] === 'string' && typeof data['is_vpn'] === 'boolean';
}

/** Both maps present. An entry in either is judged on its own, as that address's answer. */
export function isBatch(data: unknown): boolean {
    return hasMembers(data, BATCH_MEMBERS) && isObject(data['results']) && isObject(data['errors']);
}

export function isBatchError(entry: unknown): boolean {
    return hasMembers(entry, BATCH_ERROR_MEMBERS) && typeof entry['status'] === 'number';
}

export function isEntitlement(data: unknown): boolean {
    return hasMembers(data, ENTITLEMENT_MEMBERS)
        && hasMembers(data['apikey'], ENTITLEMENT_APIKEY_MEMBERS)
        && hasMembers(data['plan'], ENTITLEMENT_PLAN_MEMBERS)
        && hasMembers(data['usage'], ENTITLEMENT_USAGE_MEMBERS);
}

function isDatabase(entry: unknown): boolean {
    return hasMembers(entry, DATABASE_MEMBERS)
        && every(entry['versions'], (version) => hasMembers(version, DATABASE_VERSION_MEMBERS)
            && every(version['formats'], (format) => hasMembers(format, DATABASE_FORMAT_SIZE_MEMBERS)));
}

export function isDatabaseList(data: unknown): boolean {
    return hasMembers(data, ['databases']) && every(data['databases'], isDatabase);
}

export function isDatabaseMetadata(data: unknown): boolean {
    return hasMembers(data, DATABASE_METADATA_MEMBERS) && typeof data['id'] === 'string'
        && typeof data['entries'] === 'number' && isObject(data['schema']);
}

export function isChecksumsResponse(data: unknown): boolean {
    return hasMembers(data, ['checksums']) && hasMembers(data['checksums'], DB_CHECKSUMS_MEMBERS);
}

export function isDownloadList(data: unknown): boolean {
    return hasMembers(data, ['downloads']) && every(data['downloads'], (entry) => hasMembers(entry, DOWNLOAD_MEMBERS));
}
