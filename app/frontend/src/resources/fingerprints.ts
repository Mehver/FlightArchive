// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Pure helpers for the business-bound fingerprint workflow on the resource
 * mappings page.
 *
 * The backend (POST /api/resources/fingerprints) is authoritative: it only
 * hashes and persists fingerprints for currently cataloged, non-inbox
 * objects referenced by a persisted flight's three boarding-pass fields or
 * attachmentResourcePaths, or by an airline-logo field. The resource mappings
 * page supplies global persisted-business reference counts so the UI never
 * offers a calculation the server would reject. Inbox rows and unreferenced
 * objects are never fingerprintable. No hash-based
 * candidate computation or matching happens here (or anywhere in the UI).
 */

import type { FlightRecord } from '../api/types';
import { HASH_ALGORITHMS, PERCEPTUAL_ALGORITHMS, type HashAlgorithm, type MappingEntry } from '../rfg/api';
import type { MappingRow } from './mappingJoin';

const FLIGHT_RESOURCE_FIELDS: readonly (keyof FlightRecord)[] = [
  'paperBoardingPassFrontResourcePath',
  'paperBoardingPassBackResourcePath',
  'electronicBoardingPassResourcePath',
];
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

/**
 * Direct flight references: virtual path → number of persisted flights whose
 * boarding-pass or attachment fields reference it. Airline-logo paths are not
 * included because catalog fields are deliberately never read here.
 */
export function directFlightReferenceCounts(flights: readonly FlightRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const flight of flights) {
    const paths = new Set<string>();
    for (const field of FLIGHT_RESOURCE_FIELDS) {
      const value = flight[field];
      if (typeof value === 'string' && !value.startsWith('inbox/')) paths.add(value);
    }
    for (const value of flight.attachmentResourcePaths) {
      if (!value.startsWith('inbox/')) paths.add(value);
    }
    for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/** Which of the six supported hashes are stored on a mapping entry. */
export function storedFingerprintAlgorithms(entry: MappingEntry): HashAlgorithm[] {
  return HASH_ALGORITHMS.filter((algorithm) => {
    const value = entry[algorithm];
    return typeof value === 'string' && value.length > 0;
  });
}

export type FingerprintRowState =
  | { kind: 'hidden' }
  | { kind: 'unreferenced' }
  | { kind: 'referenced'; referenceCount: number; calculable: boolean };

/**
 * Fingerprint affordance for one mapping row:
 * - `hidden`        — inbox/unclassified or local-only rows: never show
 *   hashes or a hash action;
 * - `unreferenced`  — classified but not business-bound: visibly unreferenced,
 *   no action;
 * - `referenced`    — business-bound: show reference count and stored-hash
 *   presence; `calculable` only while the local source is still present
 *   (missing rows may display stored values but offer no calculation).
 */
export function fingerprintRowState(row: MappingRow, references: ReadonlyMap<string, number>): FingerprintRowState {
  if (row.kind === 'inbox' || row.kind === 'local_only' || !row.virtualPath || !row.entry) {
    return { kind: 'hidden' };
  }
  const referenceCount = references.get(row.virtualPath) ?? 0;
  if (referenceCount === 0) return { kind: 'unreferenced' };
  return { kind: 'referenced', referenceCount, calculable: row.kind === 'paired' };
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
export function fingerprintTargets(rows: readonly MappingRow[], references: ReadonlyMap<string, number>): FingerprintTarget[] {
  return rows.flatMap((row) => {
    const state = fingerprintRowState(row, references);
    if (state.kind !== 'referenced' || !state.calculable || !row.virtualPath || !row.localPath || !row.entry) {
      return [];
    }
    return [
      {
        virtualPath: row.virtualPath,
        localPath: row.localPath,
        entry: row.entry,
        stored: storedFingerprintAlgorithms(row.entry),
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
