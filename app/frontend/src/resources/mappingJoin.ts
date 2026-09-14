// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Read-only join between the RFG mapping document and the current local
 * catalog, reduced from the remappable-file-gateway demo's full-outer-join
 * workspace (join.ts) to FlightArchive's retained rematch workflow:
 *
 * - `paired`     — object entry whose local source is still present;
 * - `inbox`      — entry under `inbox/`: a pending new local file and
 *                  the only valid rematch candidate;
 * - `missing`    — object entry whose local source is absent from the
 *                  current catalog: the only valid rematch target;
 * - `local_only` — a catalog file no entry claims (the sync that runs with
 *                  every page load normally absorbs these into the inbox).
 *
 * Virtual paths are never edited here: a rematch preserves the object ID
 * target virtual path and only replaces its missing local source with the
 * candidate inbox entry's local file.
 */

import type { MappingEntry } from '../rfg/api';

export const INBOX_PREFIX = 'inbox/';
export const IGNORE_PREFIX = 'ignore/';

export type MappingRowKind = 'paired' | 'inbox' | 'missing' | 'local_only';
export type MappingRowFilter = 'all' | MappingRowKind;

export interface MappingRow {
  /** Stable React key: entry rows by index+path, local-only rows by path. */
  readonly key: string;
  readonly kind: MappingRowKind;
  /** Mapped virtual path; null for `local_only` rows. Read-only everywhere. */
  readonly virtualPath: string | null;
  /** Entry rows: recorded local source (last known for `missing` rows). */
  readonly localPath: string | null;
  /** Whether the local source is present in the current catalog. */
  readonly localPresent: boolean;
  /** Backing mapping entry; null for `local_only` rows. */
  readonly entry: MappingEntry | null;
}

/** Actionable states first: missing targets, then inbox candidates. */
const KIND_RANK: Record<MappingRowKind, number> = { missing: 0, inbox: 1, paired: 2, local_only: 3 };

export function buildMappingRows(localPaths: readonly string[], entries: readonly MappingEntry[]): MappingRow[] {
  const catalog = new Set(localPaths);
  const claimed = new Set<string>();
  const rows: MappingRow[] = [];

  entries.forEach((entry, index) => {
    const present = catalog.has(entry.local_path);
    if (present) claimed.add(entry.local_path);
    // Ignored resources remain a transient mapping solely to suppress picker
    // rediscovery. They are intentionally absent from the management table.
    if (entry.virtual_path.startsWith(IGNORE_PREFIX)) return;
    const kind: MappingRowKind = entry.virtual_path.startsWith(INBOX_PREFIX)
      ? 'inbox'
      : present
        ? 'paired'
        : 'missing';
    rows.push({
      key: `e:${index}:${entry.virtual_path}`,
      kind,
      virtualPath: entry.virtual_path,
      localPath: entry.local_path,
      localPresent: present,
      entry,
    });
  });
  for (const localPath of localPaths) {
    if (claimed.has(localPath)) continue;
    rows.push({ key: `l:${localPath}`, kind: 'local_only', virtualPath: null, localPath, localPresent: true, entry: null });
  }

  const sortPath = (row: MappingRow): string => row.virtualPath ?? row.localPath ?? '';
  return rows.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || sortPath(a).localeCompare(sortPath(b)));
}

export function countMappingRows(rows: readonly MappingRow[]): Record<MappingRowKind, number> {
  const counts: Record<MappingRowKind, number> = { paired: 0, inbox: 0, missing: 0, local_only: 0 };
  for (const row of rows) counts[row.kind] += 1;
  return counts;
}

/**
 * Rematch targets: non-inbox object entries whose local source is
 * absent from the current catalog. Their virtual paths are preserved by a
 * rematch — never edited.
 */
export function rematchTargets(rows: readonly MappingRow[]): MappingEntry[] {
  return rows.flatMap((row) => (row.kind === 'missing' && row.entry ? [row.entry] : []));
}

/**
 * Rematch candidates: current inbox mappings whose local file is present.
 * The candidate's local file becomes the target's new source.
 */
export function rematchCandidates(rows: readonly MappingRow[]): MappingEntry[] {
  return rows.flatMap((row) => (row.kind === 'inbox' && row.localPresent && row.entry ? [row.entry] : []));
}
