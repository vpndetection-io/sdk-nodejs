export { VPNDetection, DatabaseApi, DEFAULT_BASE_URL } from './client.js';
export type {
    Options, CacheOptions, LookupOptions, BatchOptions, DownloadsOptions,
    DownloadDestination,
} from './client.js';
export { isBogon } from './bogon.js';
export { VPNDetectionError } from './errors.js';
export type { ErrorKind } from './errors.js';
export type {
    Result, VpnDetail, ClassDetail, ProxyDetail, LookupResponse,
} from './types.js';
export { DATABASE_FORMATS, STANDINGS, LICENSE_TYPES } from './types.js';
export type {
    Database, DatabaseFormat, DatabaseFormatSize, DatabaseMetadata, DatabaseMetadataColumn,
    DatabaseVersion, DbChecksums, Download, Standing,
} from './generated/types.gen.js';
// Not a named schema: `license_type` is a NULLABLE enum, and naming one makes
// openapi-python-client emit three identical enums unioned together, so the
// spec keeps it inline for every language's sake. Derived here so a TS caller
// still has a name for it.
export type LicenseType =
    NonNullable<import('./generated/types.gen.js').Database['license_type']>;
export type {
    AccountMe, AccountApikey, AccountPlan, AccountUsage,
} from './generated/types.gen.js';
