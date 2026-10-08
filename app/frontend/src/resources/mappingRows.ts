// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { MappingEntry } from '../rfg/api';
import type { ResourceInventoryRow } from '../rfg/mapping';

export type MappingRowKind = 'paired' | 'inbox' | 'ignored' | 'missing' | 'local_only';
export type MappingRowFilter = 'all' | MappingRowKind;

export interface MappingRow {
  readonly key: string;
  readonly kind: MappingRowKind;
  readonly virtualPath: string | null;
  readonly localPath: string;
  readonly entry: MappingEntry | null;
  readonly resource: ResourceInventoryRow;
}

const KIND: Record<ResourceInventoryRow['state'], MappingRowKind> = {
  mapped: 'paired', pending: 'inbox', ignored: 'ignored', missing: 'missing', local_only: 'local_only',
};

export function toMappingRows(source: readonly ResourceInventoryRow[]): MappingRow[] {
  return source.map((resource, index) => {
    const entry = resource.entry;
    return {
      key: resource.virtualPath === null ? `l:${resource.localPath}` : `r:${index}:${resource.virtualPath}`,
      kind: KIND[resource.state], virtualPath: resource.virtualPath, localPath: resource.localPath,
      entry, resource,
    };
  });
}

export function countMappingRows(rows: readonly MappingRow[]): Record<MappingRowKind, number> {
  const counts: Record<MappingRowKind, number> = { paired: 0, inbox: 0, ignored: 0, missing: 0, local_only: 0 };
  for (const row of rows) counts[row.kind] += 1;
  return counts;
}

export function rematchTargets(rows: readonly MappingRow[]): MappingEntry[] {
  return rows.flatMap((row) => row.kind === 'missing' && row.entry ? [row.entry] : []);
}

export function rematchCandidates(rows: readonly MappingRow[]): MappingEntry[] {
  return rows.flatMap((row) => row.kind === 'inbox' && row.resource.present && row.entry ? [row.entry] : []);
}
