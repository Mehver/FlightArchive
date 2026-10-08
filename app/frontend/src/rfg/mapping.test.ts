// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import type { LocalCatalog, MappingDocument } from './api';
import {
  applyFingerprints, autoMatchMappings, ignoreMappings, materializeMapping, reconcileMapping,
  releaseMappings, rematchMappings, resourceInventory, unignoreMappings, validateMapping,
} from './mapping';

const catalog = (paths: Array<[string, number]>): LocalCatalog => ({
  local_files: paths.map(([local_path, size_bytes]) => ({ local_path, size_bytes })),
});
const mapping = (...entries: MappingDocument['entries']): MappingDocument => ({ entries });

describe('mapping validation and inventory', () => {
  it('rejects unsafe paths and local or virtual collisions', () => {
    expect(() => validateMapping(mapping({ virtual_path: '../bad', local_path: 'a' }))).toThrow(/safe/);
    expect(() => validateMapping(mapping({ virtual_path: 'a', local_path: 'a' }, { virtual_path: 'a', local_path: 'b' }))).toThrow(/virtual/);
    expect(() => validateMapping(mapping({ virtual_path: 'a', local_path: 'same' }, { virtual_path: 'b', local_path: 'same' }))).toThrow(/local/);
  });

  it('enforces mechanical size and batch limits', () => {
    expect(() => validateMapping(mapping({ virtual_path: 'a', local_path: 'a', size_bytes: -1 }))).toThrow(/size_bytes/);
    const source = mapping({ virtual_path: 'objects/a', local_path: 'a' });
    expect(() => releaseMappings(source, catalog([['a', 1]]), Array.from({ length: 257 }, (_, index) => `objects/${index}`))).toThrow(/256/);
  });

  it('derives only mapping/catalog state and never resource usage', () => {
    const rows = resourceInventory(
      mapping(
        { virtual_path: 'objects/live.png', local_path: 'live.png' },
        { virtual_path: 'objects/gone.png', local_path: 'gone.png' },
        { virtual_path: 'inbox/new.png', local_path: 'new.png' },
        { virtual_path: 'ignore/nope.png', local_path: 'nope.png' },
      ),
      catalog([['live.png', 1], ['new.png', 2], ['only.png', 3]]),
    );
    expect(rows.map(({ state }) => state)).toEqual(['mapped', 'missing', 'pending', 'missing', 'local_only']);
    expect(rows.every((row) => !('uses' in row) && !('capabilities' in row))).toBe(true);
  });
});

describe('temporary and stable transitions', () => {
  it('reconcile adds unmapped sources and expires only missing temporary entries', () => {
    const result = reconcileMapping(mapping(
      { virtual_path: 'objects/missing.png', local_path: 'old.png' },
      { virtual_path: 'inbox/expired.png', local_path: 'expired.png' },
      { virtual_path: 'ignore/expired-2.png', local_path: 'expired-2.png' },
    ), catalog([['new/a.png', 4]]));
    expect(result.entries).toEqual([
      { virtual_path: 'objects/missing.png', local_path: 'old.png' },
      { virtual_path: 'inbox/new/a.png', local_path: 'new/a.png', size_bytes: 4 },
    ]);
  });

  it('materializes present inbox only, preserves its extension, and rejects collisions', () => {
    const source = mapping({ virtual_path: 'inbox/a/photo.PNG', local_path: 'a/photo.PNG', size_bytes: 9 });
    expect(materializeMapping(source, catalog([['a/photo.PNG', 9]]), 'inbox/a/photo.PNG', 'objects/ticket.PNG').entries[0].virtual_path).toBe('objects/ticket.PNG');
    expect(() => materializeMapping(source, catalog([]), 'inbox/a/photo.PNG', 'objects/ticket.PNG')).toThrow(/present/);
    expect(() => materializeMapping(source, catalog([['a/photo.PNG', 9]]), 'inbox/a/photo.PNG', 'ignore/ticket.PNG')).toThrow(/stable/);
    expect(() => materializeMapping(source, catalog([['a/photo.PNG', 9]]), 'inbox/a/photo.PNG', 'objects/ticket.jpg')).toThrow(/extension/);
  });

  it('release never checks use or deletes a source and clears all hashes', () => {
    const result = releaseMappings(mapping({ virtual_path: 'shared/file.png', local_path: 'x/file.png', size_bytes: 2, sha256: 'old' }), catalog([['x/file.png', 2]]), ['shared/file.png']);
    expect(result).toEqual(mapping({ virtual_path: 'inbox/x/file.png', local_path: 'x/file.png', size_bytes: 2 }));
    expect(() => releaseMappings(mapping({ virtual_path: 'stable.png', local_path: 'missing.png' }), catalog([]), ['stable.png'])).toThrow(/present/);
  });

  it('ignore and unignore encode the source path in their temporary namespace', () => {
    const pending = mapping({ virtual_path: 'inbox/folder/a.png', local_path: 'folder/a.png' });
    const ignored = ignoreMappings(pending, catalog([['folder/a.png', 1]]), ['inbox/folder/a.png']);
    expect(ignored.entries[0].virtual_path).toBe('ignore/folder/a.png');
    expect(unignoreMappings(ignored, catalog([['folder/a.png', 1]]), ['ignore/folder/a.png']).entries[0].virtual_path).toBe('inbox/folder/a.png');
  });
});

describe('rematching and fingerprints', () => {
  it('allows FORCE rematch onto a present stable target, clears old hashes, and consumes the candidate', () => {
    const result = rematchMappings(mapping(
      { virtual_path: 'objects/target.png', local_path: 'current.png', size_bytes: 3, sha256: 'old' },
      { virtual_path: 'inbox/replacement.png', local_path: 'replacement.png', size_bytes: 7, md5: 'candidate' },
    ), catalog([['current.png', 3], ['replacement.png', 7]]), [{
      targetVirtualPath: 'objects/target.png', candidateVirtualPath: 'inbox/replacement.png',
    }]);
    expect(result).toEqual(mapping({ virtual_path: 'objects/target.png', local_path: 'replacement.png', size_bytes: 7 }));
  });

  it('swaps a present inbox source into a missing stable target and keeps only verified hashes', () => {
    const result = rematchMappings(mapping(
      { virtual_path: 'objects/target.png', local_path: 'gone.png', sha256: 'old', md5: 'old' },
      { virtual_path: 'inbox/replacement.png', local_path: 'replacement.png', size_bytes: 7 },
    ), catalog([['replacement.png', 7]]), [{
      targetVirtualPath: 'objects/target.png', candidateVirtualPath: 'inbox/replacement.png',
      hashes: { sha256: 'verified' },
    }]);
    expect(result).toEqual(mapping({ virtual_path: 'objects/target.png', local_path: 'replacement.png', size_bytes: 7, sha256: 'verified' }));
  });

  it('auto matching only applies unique one-to-one matches and reports ambiguity', () => {
    const source = mapping(
      { virtual_path: 'objects/a.png', local_path: 'gone-a.png', size_bytes: 5, sha256: 'same' },
      { virtual_path: 'objects/b.png', local_path: 'gone-b.png', size_bytes: 5, sha256: 'same' },
      { virtual_path: 'inbox/new.png', local_path: 'new.png', size_bytes: 5 },
    );
    const ambiguous = autoMatchMappings(source, catalog([['new.png', 5]]), ['objects/a.png', 'objects/b.png'], ['inbox/new.png'], ['sizeBytes'], { 'inbox/new.png': {} });
    expect(ambiguous.applied).toBe(0);
    expect(ambiguous.ambiguous).toEqual(['objects/a.png', 'objects/b.png']);
    const unique = autoMatchMappings(source, catalog([['new.png', 5]]), ['objects/a.png'], ['inbox/new.png'], ['sha256'], { 'inbox/new.png': { sha256: 'same' } });
    expect(unique.applied).toBe(1);
    expect(unique.document.entries.find((entry) => entry.virtual_path === 'objects/a.png')?.local_path).toBe('new.png');
  });

  it('applies hashes to any present stable mapping and preserves source metadata', () => {
    const source = mapping({ virtual_path: 'unreferenced/file.bin', local_path: 'file.bin', size_bytes: 12 });
    expect(applyFingerprints(source, catalog([['file.bin', 12]]), [{ virtualPath: 'unreferenced/file.bin', localPath: 'file.bin', algorithm: 'sha256', value: 'ok' }])).toEqual(
      mapping({ virtual_path: 'unreferenced/file.bin', local_path: 'file.bin', size_bytes: 12, sha256: 'ok' }),
    );
  });
});
