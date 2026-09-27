// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { ReactNode } from 'react';

function foldedWithSourceRanges(value: string) {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let sourceOffset = 0;
  for (const character of value) {
    const transformed = character.toLowerCase();
    folded += transformed;
    for (let index = 0; index < transformed.length; index += 1) {
      starts.push(sourceOffset);
      ends.push(sourceOffset + character.length);
    }
    sourceOffset += character.length;
  }
  return { folded, starts, ends };
}

/** Safely marks every case-insensitive query match without injecting HTML. */
export function SearchHighlight({ text, query }: { text: string; query?: string }) {
  const needle = query?.trim();
  if (!needle) return <>{text}</>;
  const { folded, starts, ends } = foldedWithSourceRanges(text);
  const target = needle.toLowerCase(), parts: ReactNode[] = [];
  let foldedCursor = 0, sourceCursor = 0, index: number;
  while ((index = folded.indexOf(target, foldedCursor)) !== -1) {
    const start = starts[index];
    const end = ends[index + target.length - 1];
    foldedCursor = index + target.length;
    if (start < sourceCursor || end === undefined) continue;
    if (start > sourceCursor) parts.push(text.slice(sourceCursor, start));
    parts.push(<mark key={`${start}-${end}`}>{text.slice(start, end)}</mark>);
    sourceCursor = end;
  }
  if (sourceCursor < text.length) parts.push(text.slice(sourceCursor));
  return <>{parts}</>;
}
