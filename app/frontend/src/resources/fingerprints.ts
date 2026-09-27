// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Pure helpers for the business-bound fingerprint workflow on the resource
 * mappings page.
 *
 * The backend (POST /api/resources/fingerprints) is authoritative: it only
 * hashes and persists fingerprints for currently cataloged, stable
 * objects referenced by a persisted flight's three boarding-pass fields or
 * attachmentResourcePaths, or by an airline-logo field. The resource mappings
 * page supplies global persisted-business reference counts so the UI never
 * offers a calculation the server would reject. Temporary rows and unreferenced
 * objects are never fingerprintable. No hash-based
 * candidate computation or matching happens here (or anywhere in the UI).
 */

import { HASH_ALGORITHMS, PERCEPTUAL_ALGORITHMS, type HashAlgorithm, type MappingEntry } from '../rfg/api';
import type { MappingRow } from './mappingRows';

const RASTER_IMAGE_SUFFIX = /\.(avif|bmp|gif|jpe?g|png|webp)$/i;

/** RFG perceptual hashes need a decodable raster; SVG and unknown types only
 * support content hashes. */
export function supportsPerceptualFingerprint(localPath: string): boolean {
  return RASTER_IMAGE_SUFFIX.test(localPath);
}

export function supportedFingerprintAlgorithms(localPath: string): HashAlgorithm[] {
  return HASH_ALGORITHMS.filter((algorithm) => !PERCEPTUAL_ALGORITHMS.includes(algorithm) || supportsPerceptualFingerprint(localPath));
}

/** Backend request cap: at most this many virtual paths per fingerprint call. */
export const FINGERPRINT_MAX_PATHS_PER_REQUEST = 32;

export type FingerprintRowState =
  | { kind: 'hidden' }
  | { kind: 'unreferenced' }
  | { kind: 'referenced'; referenceCount: number; calculable: boolean };

/**
 * Fingerprint affordance for one mapping row:
 * - `hidden`        — temporary or local-only rows: never show
 *   hashes or a hash action;
 * - `unreferenced`  — classified but not business-bound: visibly unreferenced,
 *   no action;
 * - `referenced`    — business-bound: show reference count and stored-hash
 *   presence; `calculable` only while the local source is still present
 *   (missing rows may display stored values but offer no calculation).
 */
export function fingerprintRowState(row: MappingRow): FingerprintRowState {
  if (row.kind === 'inbox' || row.kind === 'ignored' || row.kind === 'local_only' || !row.virtualPath || !row.entry) {
    return { kind: 'hidden' };
  }
  const referenceCount = row.review.uses.length;
  if (referenceCount === 0) return { kind: 'unreferenced' };
  return { kind: 'referenced', referenceCount, calculable: row.review.capabilities.fingerprint };
}

/** One calculable target: a present, classified, business-bound entry. */
export interface FingerprintTarget {
  virtualPath: string;
  localPath: string;
  entry: MappingEntry;
  stored: readonly HashAlgorithm[];
  supported: readonly HashAlgorithm[];
}

/** Targets for a fingerprint run, resolved from current rows + references. */
export function fingerprintTargets(rows: readonly MappingRow[]): FingerprintTarget[] {
  return rows.flatMap((row) => {
    const state = fingerprintRowState(row);
    if (state.kind !== 'referenced' || !state.calculable || !row.virtualPath || !row.localPath || !row.entry) {
      return [];
    }
    return [
      {
        virtualPath: row.virtualPath,
        localPath: row.localPath,
        entry: row.entry,
        stored: row.review.fingerprints,
        supported: supportedFingerprintAlgorithms(row.localPath),
      },
    ];
  });
}

/** Targets missing at least one of the given algorithms. */
export function targetsMissingAlgorithms<T extends { stored: readonly HashAlgorithm[]; supported?: readonly HashAlgorithm[] }>(
  targets: readonly T[],
  algorithms: readonly HashAlgorithm[],
): T[] {
  return targets.filter((target) => algorithms.some((algorithm) => (target.supported?.includes(algorithm) ?? true) && !target.stored.includes(algorithm)));
}

/** Split virtual paths into request-sized chunks (backend cap). */
export function chunkVirtualPaths(paths: readonly string[], size = FINGERPRINT_MAX_PATHS_PER_REQUEST): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < paths.length; index += size) {
    chunks.push(paths.slice(index, index + size));
  }
  return chunks;
}
