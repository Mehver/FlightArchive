// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Minimal same-origin client for RFG's documented public HTTP API. */

/** The six hash algorithms RFG can compute, mirrored from its hash API and
 *  exactly the set the FlightArchive fingerprint endpoint accepts. */
export const HASH_ALGORITHMS = ['crc32', 'md5', 'sha256', 'ahash', 'dhash', 'phash'] as const;
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

/** Perceptual image hashes: they require a supported raster image and fail
 *  terminally (unsupported_image) for any other payload. */
export const PERCEPTUAL_ALGORITHMS: readonly HashAlgorithm[] = ['ahash', 'dhash', 'phash'];

export interface MappingEntry {
  virtual_path: string;
  local_path: string;
  size_bytes?: number | null;
  crc32?: string | null;
  md5?: string | null;
  sha256?: string | null;
  ahash?: string | null;
  dhash?: string | null;
  phash?: string | null;
}

export interface LocalFile { local_path: string; size_bytes: number }
export interface LocalCatalog { local_files: LocalFile[] }
export interface MappingDocument { entries: MappingEntry[] }
export interface MappingSnapshot { document: MappingDocument; etag: string | null }
export interface HashRequest { local_path: string; algorithm: HashAlgorithm }
export interface HashFailure { code: string; message: string; retryable: boolean }
export type HashTerminalResult = {
  local_path: string;
  algorithm: HashAlgorithm;
  profile: string | null;
  code: string;
  detail: string | null;
} & ({ status: 'succeeded'; value: string; error: null } | { status: 'failed'; value: null; error: HashFailure });

export class RfgHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RfgHttpError';
  }
}

export interface RfgClient {
  getCatalog(signal?: AbortSignal): Promise<LocalCatalog>;
  getMapping(signal?: AbortSignal): Promise<MappingSnapshot>;
  putMapping(document: MappingDocument, signal?: AbortSignal): Promise<MappingDocument>;
  computeHash(request: HashRequest, signal?: AbortSignal): Promise<HashTerminalResult>;
  getResource(virtualPath: string, init?: RequestInit): Promise<Response>;
  headResource(virtualPath: string, init?: RequestInit): Promise<Response>;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `RFG request failed (${response.status})`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) message = body.detail;
    } catch { /* RFG resource and proxy errors need not be JSON. */ }
    throw new RfgHttpError(response.status, message);
  }
  return await response.json() as T;
}

export const rfgClient: RfgClient = {
  getCatalog: (signal) => jsonRequest<LocalCatalog>('/api/v1/meta/local', { signal }),
  async getMapping(signal) {
    const response = await fetch('/api/v1/meta/map', { signal });
    if (!response.ok) throw new RfgHttpError(response.status, `RFG mapping request failed (${response.status})`);
    return { document: await response.json() as MappingDocument, etag: response.headers.get('ETag') };
  },
  putMapping: (document, signal) => jsonRequest<MappingDocument>('/api/v1/meta/map', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(document), signal,
  }),
  computeHash: (request, signal) => jsonRequest<HashTerminalResult>('/api/v1/hashes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal,
  }),
  getResource: (virtualPath, init) => fetch(resourceUrl(virtualPath), { ...init, method: 'GET' }),
  headResource: (virtualPath, init) => fetch(resourceUrl(virtualPath), { ...init, method: 'HEAD' }),
};
export function resourceUrl(virtualPath: string): string {
  return `/res/${virtualPath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Domain-neutral backend thumbnail relay for raster display and bounded Studio editing. */
export function thumbnailUrl(virtualPath: string, scale: number): string {
  return `/api/thumbnails/${virtualPath.split('/').map(encodeURIComponent).join('/')}?scale=${scale}`;
}
