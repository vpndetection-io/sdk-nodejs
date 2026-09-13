export { VPNDetection, DatabaseApi, DEFAULT_BASE_URL } from './client.js';
export type {
    Options, CacheOptions, LookupOptions, BatchOptions, DownloadsOptions, DatasetFormat,
    DownloadDestination,
} from './client.js';
export { isBogon } from './bogon.js';
export { VPNDetectionError } from './errors.js';
export type { ErrorKind } from './errors.js';
export type {
    Result, VpnDetail, ClassDetail, ProxyDetail, LookupResponse,
} from './types.js';
export type {
    Database, DatabaseVersion, DatabaseMetadata, DatabaseMetadataColumn, DatabaseFormatSize,
    DbChecksums, Download,
} from './generated/types.gen.js';
