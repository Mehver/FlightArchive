// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization tests for the read-only mapping/catalog join that backs
 * the Resource Mappings page. These pin the row classification
 * (paired / inbox / missing / local_only), the actionable-first ordering and
 * the rematch target/candidate derivation before any behavior-neutral
 * cleanup: a rematch target is exactly a *missing classified* entry, a
 * rematch candidate is exactly a *present inbox* entry.
 */

import { describe, expect, it } from 'vitest';
import type { MappingEntry } from '../rfg/api';
import {
  buildMappingRows,
  countMappingRows,
  rematchCandidates,
  rematchTargets,
  type MappingRow,
} from './mappingJoin';

function entry(virtualPath: string, localPath: string): MappingEntry {
  return { virtual_path: virtualPath, local_path: localPath };
}

function kinds(rows: readonly MappingRow[]): string[] {
  return rows.map((row) => row.kind);
}

describe('buildMappingRows classification', () => {
  it('classifies an object entry with a present local source as paired', () => {
    const rows = buildMappingRows(['ticket.png'], [entry('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', 'ticket.png')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'paired',
      virtualPath: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      localPath: 'ticket.png',
      localPresent: true,
    });
    expect(rows[0].entry?.virtual_path).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png');
  });

  it('classifies an inbox entry as inbox whether or not its local file is present', () => {
    const rows = buildMappingRows(['new.png'], [
      entry('inbox/new.png', 'new.png'),
      entry('inbox/gone.png', 'gone.png'),
    ]);
    const byVirtual = new Map(rows.map((row) => [row.virtualPath, row]));
    expect(byVirtual.get('inbox/new.png')).toMatchObject({ kind: 'inbox', localPresent: true });
    // An inbox row with an absent source is still inbox — never "missing":
    // missing is reserved for object entries (rematch targets).
    expect(byVirtual.get('inbox/gone.png')).toMatchObject({ kind: 'inbox', localPresent: false });
  });

  it('classifies an object entry with an absent local source as missing', () => {
    const rows = buildMappingRows([], [entry('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png', 'receipt.png')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'missing', localPresent: false, localPath: 'receipt.png' });
  });

  it('reports catalog files claimed by no entry as local_only rows', () => {
    const rows = buildMappingRows(['claimed.png', 'stray.png'], [entry('inbox/claimed.png', 'claimed.png')]);
    const stray = rows.find((row) => row.kind === 'local_only');
    expect(stray).toMatchObject({ virtualPath: null, localPath: 'stray.png', localPresent: true, entry: null });
    expect(rows.some((row) => row.localPath === 'claimed.png' && row.kind === 'local_only')).toBe(false);
  });

  it('does not turn a missing entry\'s recorded local path into a local_only row', () => {
    // The catalog lost the file entirely: exactly one (missing) row exists.
    const rows = buildMappingRows(['other.png'], [entry('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png', 'pass.png')]);
    expect(kinds(rows).sort()).toEqual(['local_only', 'missing']);
    expect(rows.filter((row) => row.localPath === 'pass.png')).toHaveLength(1);
  });

  it('claims a local file shared by several present entries only once', () => {
    const rows = buildMappingRows(['shared.png'], [
      entry('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.png', 'shared.png'),
      entry('inbox/shared.png', 'shared.png'),
    ]);
    expect(kinds(rows).sort()).toEqual(['inbox', 'paired']);
    expect(rows.some((row) => row.kind === 'local_only')).toBe(false);
  });

  it('produces no rows for empty inputs', () => {
    expect(buildMappingRows([], [])).toEqual([]);
  });
});

describe('buildMappingRows ordering and keys', () => {
  it('orders actionable kinds first: missing, inbox, paired, then local_only', () => {
    const rows = buildMappingRows(['inbox-file.png', 'paired-file.png', 'stray-file.png'], [
      entry('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.png', 'paired-file.png'),
      entry('inbox/inbox-file.png', 'inbox-file.png'),
      entry('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.png', 'gone-file.png'),
    ]);
    expect(kinds(rows)).toEqual(['missing', 'inbox', 'paired', 'local_only']);
  });

  it('sorts by virtual path within a kind, falling back to the local path for local_only rows', () => {
    const rows = buildMappingRows(['z-stray.png', 'a-stray.png'], [
      entry('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png', 'gone-b.png'),
      entry('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', 'gone-a.png'),
    ]);
    expect(rows.map((row) => row.virtualPath ?? row.localPath)).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
      'a-stray.png',
      'z-stray.png',
    ]);
  });

  it('gives entry rows index-scoped keys and local_only rows path keys', () => {
    const rows = buildMappingRows(['stray.png'], [
      entry('inbox/a.png', 'a.png'),
      entry('inbox/b.png', 'b.png'),
    ]);
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.find((row) => row.virtualPath === 'inbox/a.png')?.key).toBe('e:0:inbox/a.png');
    expect(rows.find((row) => row.virtualPath === 'inbox/b.png')?.key).toBe('e:1:inbox/b.png');
    expect(rows.find((row) => row.kind === 'local_only')?.key).toBe('l:stray.png');
  });
});

describe('countMappingRows', () => {
  it('counts every kind, including zeroes', () => {
    const rows = buildMappingRows(['inbox.png', 'stray.png'], [
      entry('inbox/inbox.png', 'inbox.png'),
      entry('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', 'gone.png'),
    ]);
    expect(countMappingRows(rows)).toEqual({ paired: 0, inbox: 1, missing: 1, local_only: 1 });
  });

  it('returns zero counts for no rows', () => {
    expect(countMappingRows([])).toEqual({ paired: 0, inbox: 0, missing: 0, local_only: 0 });
  });
});

describe('rematch targets and candidates', () => {
  const entries = [
    entry('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', 'gone.png'),
    entry('inbox/candidate.png', 'candidate.png'),
    entry('inbox/unserved.png', 'unserved.png'),
    entry('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png', 'paired.png'),
  ];
  // 'unserved.png' is deliberately absent from the catalog: an inbox row
  // without a present local file must not become a candidate.
  const rows = buildMappingRows(['candidate.png', 'paired.png', 'stray.png'], entries);

  it('targets exactly the missing object entries, preserving entry identity', () => {
    const targets = rematchTargets(rows);
    expect(targets).toEqual([entries[0]]);
    expect(targets[0].virtual_path).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png');
  });

  it('candidates exactly the inbox entries whose local file is present', () => {
    const candidates = rematchCandidates(rows);
    expect(candidates).toEqual([entries[1]]);
    expect(candidates[0].virtual_path).toBe('inbox/candidate.png');
  });

  it('never offers inbox rows as targets or missing/paired/local_only rows as candidates', () => {
    const targetPaths = rematchTargets(rows).map((item) => item.virtual_path);
    const candidatePaths = rematchCandidates(rows).map((item) => item.virtual_path);
    expect(targetPaths).not.toContain('inbox/unserved.png');
    expect(candidatePaths).not.toContain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png');
    expect(candidatePaths).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png');
    expect(candidatePaths).not.toContain('inbox/unserved.png');
  });

  it('returns empty lists when nothing is actionable', () => {
    const calm = buildMappingRows(['a.png'], [entry('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', 'a.png')]);
    expect(rematchTargets(calm)).toEqual([]);
    expect(rematchCandidates(calm)).toEqual([]);
  });
});
