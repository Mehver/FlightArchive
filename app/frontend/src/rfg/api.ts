// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Minimal same-origin RFG client, adapted from remappable-file-gateway demo. */

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
  /** Fingerprints persisted by POST /api/resources/fingerprints. They only
   *  appear on object entries referenced by persisted flight resources
   *  (boarding passes / attachments) or airline logos, never on inbox
   *  entries. Absent when no fingerprint has been stored. */
  crc32?: string;
  md5?: string;
  sha256?: string;
  ahash?: string;
  dhash?: string;
  phash?: string;
}
export interface MappingDocument { entries: MappingEntry[] }

/** Mapping document plus the ETag RFG sent with it (null when absent). The
 *  ETag is forwarded as `ifMatch` to FlightArchive mapping mutations so
 *  concurrent mapping changes are detected; this client never issues the
 *  raw RFG PUT /api/v1/meta/map itself. */
export interface MappingMeta { document: MappingDocument; etag: string | null }

export function resourceUrl(virtualPath: string): string {
  return `/res/${virtualPath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Cached WebP thumbnail route for raster images; unsupported resources get
 *  an error response (e.g. 415) and callers must NOT fall back to
 *  {@link resourceUrl} for rasters — only SVG paths are served directly. */
export function imageUrl(virtualPath: string): string {
  return `/images/${virtualPath.split('/').map(encodeURIComponent).join('/')}`;
}

const SVG_PATH = /\.svg$/i;

/** Returns the appropriate display URL for a resource.
 *  SVG files use the original route; raster files use the cached thumbnail route. */
export function resourceDisplayUrl(virtualPath: string): string {
  return SVG_PATH.test(virtualPath) ? resourceUrl(virtualPath) : imageUrl(virtualPath);
}

export const rfg = {
  async getMappingMeta(signal?: AbortSignal): Promise<MappingMeta> {
    const response = await fetch('/api/v1/meta/map', { signal });
    if (!response.ok) throw new Error(`RFG mapping request failed (${response.status})`);
    return { document: (await response.json()) as MappingDocument, etag: response.headers.get('etag') };
  },
  async getMapping(signal?: AbortSignal): Promise<MappingDocument> {
    return (await rfg.getMappingMeta(signal)).document;
  },
  resourceUrl,
  imageUrl,
};
