// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Pure presentation/filtering helpers for the resource picker dialog. The
 * picker offers a thumbnail grid and a file-manager list over the same
 * filtered, identically ordered entries; keeping the path classification
 * and ordering logic here lets both views (and their tests) share it.
 */

import type { MappingEntry } from '../rfg/api';

export const IMAGE_EXTENSIONS = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;

/** Bounded page size so only this many cards/rows (and thumbnails for present images) render at once. */
export const RESOURCE_PICKER_PAGE_SIZE = 24;

export function isImageResource(virtualPath: string): boolean {
  return IMAGE_EXTENSIONS.test(virtualPath);
}

/** Final path segment — the display name of the entry. */
export function leafName(virtualPath: string): string {
  return virtualPath.split('/').pop() ?? virtualPath;
}

/** Everything before the final segment — the file-manager "location" context ('' for root-level entries). */
export function parentFolder(virtualPath: string): string {
  const index = virtualPath.lastIndexOf('/');
  return index === -1 ? '' : virtualPath.slice(0, index);
}

/** Uppercase extension for the type/kind column ('' when the name has no extension). */
export function fileKind(virtualPath: string): string {
  const name = leafName(virtualPath);
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toUpperCase();
}

/** Pending entries live under the inbox prefix until a successful saved use materializes a named object path. */
export function isUnclassified(virtualPath: string): boolean {
  return virtualPath.startsWith('inbox/');
}

/**
 * The picker's visible entries: image-only filtering (for logo/boarding-pass
 * slots), case-insensitive substring search, and the stable ordering that
 * surfaces unclassified inbox files first, then alphabetical by path. Both
 * view modes and the pagination operate on exactly this result. Retained
 * missing mappings stay included so callers can show them as unavailable
 * rematch targets rather than silently treating them as selectable files.
 */
export function filterResourceEntries(entries: MappingEntry[], imageOnly: boolean, query: string): MappingEntry[] {
  const needle = query.trim().toLowerCase();
  return entries
    .filter((entry) => (!imageOnly || isImageResource(entry.virtual_path)) && (!needle || entry.virtual_path.toLowerCase().includes(needle)))
    .sort((a, b) => Number(isUnclassified(b.virtual_path)) - Number(isUnclassified(a.virtual_path)) || a.virtual_path.localeCompare(b.virtual_path));
}
