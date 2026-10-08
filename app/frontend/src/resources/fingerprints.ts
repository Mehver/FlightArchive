// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Pure helpers for fingerprinting present stable RFG mappings.
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

export type FingerprintRowState = { kind: 'hidden' } | { kind: 'stable'; calculable: boolean };

/**
 * Stable rows display hashes; only rows whose local source is present can be
 * calculated. Temporary and local-only rows hide fingerprint controls.
 */
export function fingerprintRowState(row: MappingRow): FingerprintRowState {
  if (row.kind === 'inbox' || row.kind === 'ignored' || row.kind === 'local_only' || !row.virtualPath || !row.entry) {
    return { kind: 'hidden' };
  }
  return { kind: 'stable', calculable: row.resource.present };
}

/** One calculable target: a present stable entry. */
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
    if (state.kind !== 'stable' || !state.calculable || !row.virtualPath || !row.localPath || !row.entry) {
      return [];
    }
    return [
      {
        virtualPath: row.virtualPath,
        localPath: row.localPath,
        entry: row.entry,
        stored: HASH_ALGORITHMS.filter((algorithm) => Boolean(row.entry?.[algorithm])),
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

/** Split virtual paths into small sequential calculation chunks. */
export function chunkVirtualPaths(paths: readonly string[], size = FINGERPRINT_MAX_PATHS_PER_REQUEST): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < paths.length; index += size) {
    chunks.push(paths.slice(index, index + size));
  }
  return chunks;
}
