// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Thin presentation adapter for the backend-authoritative review snapshot.
 * It deliberately does not join, classify, or rebuild resource usage. */
import type { ResourceReviewRow } from '../api/types';
import type { MappingEntry } from '../rfg/api';

export type MappingRowKind = 'paired' | 'inbox' | 'ignored' | 'missing' | 'local_only';
export type MappingRowFilter = 'all' | MappingRowKind;

export interface MappingRow {
  readonly key: string;
  readonly kind: MappingRowKind;
  readonly virtualPath: string | null;
  readonly localPath: string;
  readonly entry: MappingEntry | null;
  readonly review: ResourceReviewRow;
}

const KIND: Record<ResourceReviewRow['state'], MappingRowKind> = {
  mapped: 'paired', pending: 'inbox', ignored: 'ignored', missing: 'missing', local_only: 'local_only',
};

export function toMappingRows(source: readonly ResourceReviewRow[]): MappingRow[] {
  return source.map((review, index) => {
    const entry = review.virtualPath === null ? null : {
      virtual_path: review.virtualPath,
      local_path: review.localPath,
      size_bytes: review.sizeBytes,
    } as MappingEntry;
    return {
      key: review.virtualPath === null ? `l:${review.localPath}` : `r:${index}:${review.virtualPath}`,
      kind: KIND[review.state], virtualPath: review.virtualPath, localPath: review.localPath,
      entry, review,
    };
  });
}

export function countMappingRows(rows: readonly MappingRow[]): Record<MappingRowKind, number> {
  const counts: Record<MappingRowKind, number> = { paired: 0, inbox: 0, ignored: 0, missing: 0, local_only: 0 };
  for (const row of rows) counts[row.kind] += 1;
  return counts;
}

export function rematchTargets(rows: readonly MappingRow[]): MappingEntry[] {
  return rows.flatMap((row) => row.review.capabilities.rematchTarget && row.entry ? [row.entry] : []);
}

export function rematchCandidates(rows: readonly MappingRow[]): MappingEntry[] {
  return rows.flatMap((row) => row.review.capabilities.rematchCandidate && row.entry ? [row.entry] : []);
}
