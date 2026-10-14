// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import type { LocalCatalog, MappingDocument } from './api';
import {
  applyFingerprints, autoMatchMappings, ignoreMappings, reconcileMapping,
  releaseMappings, rematchMappings, resolveMappingTransitions, resourceInventory, transitionMappings, unignoreMappings, validateMapping,
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
    expect(rows.map(({ state }) => state)).toEqual(['mapped', 'missing', 'pending', 'ignored']);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ state: 'ignored', present: false });
    expect(rows.every((row) => !('uses' in row) && !('capabilities' in row))).toBe(true);
  });
});

describe('temporary and stable transitions', () => {
  it('completes discovery, ignore, first binding, missing rename, release, and rediscovery as one lifecycle', () => {
    const present = catalog([['unique/source.png', 11]]);
    let current = reconcileMapping(mapping(), present);
    expect(current).toEqual(mapping({ virtual_path: 'inbox/unique/source.png', local_path: 'unique/source.png', size_bytes: 11 }));
    current = ignoreMappings(current, present, ['inbox/unique/source.png']);
    current = reconcileMapping(current, catalog([]));
    expect(current.entries).toEqual([]);
    current = reconcileMapping(current, present);
    expect(current.entries[0].virtual_path).toBe('inbox/unique/source.png');
    current = transitionMappings(current, present, [{ from: 'inbox/unique/source.png', to: 'objects/unique.png' }]);
    current.entries[0].sha256 = 'remembered';
    current = transitionMappings(current, catalog([]), [{ from: 'objects/unique.png', to: '20300102zx0007a0.png' }]);
    expect(resourceInventory(current, catalog([]))[0]).toMatchObject({ state: 'missing', present: false });
    expect(current.entries[0].sha256).toBe('remembered');
    current = releaseMappings(current, catalog([]), ['20300102zx0007a0.png']);
    expect(current.entries).toEqual([]);
    current = reconcileMapping(current, present);
    expect(current).toEqual(mapping({ virtual_path: 'inbox/unique/source.png', local_path: 'unique/source.png', size_bytes: 11 }));
  });

  it('reconcile adds unmapped sources and expires missing inbox and ignore entries', () => {
    const result = reconcileMapping(mapping(
      { virtual_path: 'objects/missing.png', local_path: 'old.png' },
      { virtual_path: 'inbox/expired.png', local_path: 'expired.png' },
      { virtual_path: 'ignore/expired-2.png', local_path: 'expired-2.png' },
      { virtual_path: 'inbox/copy.png:Zone.Identifier', local_path: 'copy.png:Zone.Identifier' },
    ), catalog([['new/a.png', 4]]));
    expect(result.entries).toEqual([
      { virtual_path: 'objects/missing.png', local_path: 'old.png' },
      { virtual_path: 'inbox/new/a.png', local_path: 'new/a.png', size_bytes: 4 },
    ]);
  });

  it('coordinates present inbox first bindings, preserves extensions, and rejects invalid transitions', () => {
    const source = mapping({ virtual_path: 'inbox/a/photo.PNG', local_path: 'a/photo.PNG', size_bytes: 9 });
    expect(transitionMappings(source, catalog([['a/photo.PNG', 9]]), [{ from: 'inbox/a/photo.PNG', to: 'objects/ticket.PNG' }]).entries[0].virtual_path).toBe('objects/ticket.PNG');
    expect(() => transitionMappings(source, catalog([]), [{ from: 'inbox/a/photo.PNG', to: 'objects/ticket.PNG' }])).toThrow(/present inbox/);
    expect(() => transitionMappings(source, catalog([['a/photo.PNG', 9]]), [{ from: 'inbox/a/photo.PNG', to: 'ignore/ticket.PNG' }])).toThrow(/stable/);
    expect(() => transitionMappings(source, catalog([['a/photo.PNG', 9]]), [{ from: 'inbox/a/photo.PNG', to: 'objects/ticket.jpg' }])).toThrow(/extension/);
    expect(() => transitionMappings(source, catalog([['a/photo.PNG', 9]]), [{ from: 'inbox/a/photo.PNG', to: null }])).toThrow(/present inbox/);
  });

  it('release never checks use or deletes a source and clears all hashes', () => {
    const result = releaseMappings(mapping({ virtual_path: 'shared/file.png', local_path: 'x/file.png', size_bytes: 2, sha256: 'old' }), catalog([['x/file.png', 2]]), ['shared/file.png']);
    expect(result).toEqual(mapping({ virtual_path: 'inbox/x/file.png', local_path: 'x/file.png', size_bytes: 2 }));
    expect(releaseMappings(mapping({ virtual_path: 'stable.png', local_path: 'missing.png', size_bytes: 8, sha256: 'old' }), catalog([]), ['stable.png'])).toEqual(mapping());
  });

  it('atomically renames and releases coordinated mappings while preserving rename metadata', () => {
    const source = mapping(
      { virtual_path: 'objects/keep.png', local_path: 'a.png', size_bytes: 2, sha256: 'hash' },
      { virtual_path: 'objects/drop.jpg', local_path: 'b.jpg', size_bytes: 3, md5: 'old' },
    );
    expect(transitionMappings(source, catalog([['a.png', 2], ['b.jpg', 3]]), [
      { from: 'objects/keep.png', to: '20300102zx0007a0.png' },
      { from: 'objects/drop.jpg', to: null },
    ])).toEqual(mapping(
      { virtual_path: '20300102zx0007a0.png', local_path: 'a.png', size_bytes: 2, sha256: 'hash' },
      { virtual_path: 'inbox/b.jpg', local_path: 'b.jpg', size_bytes: 3 },
    ));
    expect(() => transitionMappings(mapping(...source.entries, { virtual_path: 'objects/taken.png', local_path: 'c.png' }), catalog([['a.png', 2], ['b.jpg', 3], ['c.png', 4]]), [{ from: 'objects/keep.png', to: 'objects/taken.png' }])).toThrow(/collision/);
    expect(transitionMappings(source, catalog([['b.jpg', 3]]), [{ from: 'objects/keep.png', to: 'objects/new.png' }]).entries[0]).toEqual(
      { virtual_path: 'objects/new.png', local_path: 'a.png', size_bytes: 2, sha256: 'hash' },
    );
  });

  it('allocates flat role collisions without reusing paths released by the same operation', () => {
    const source = mapping(
      { virtual_path: '20300102zx0007a0.jpg', local_path: 'old-front.jpg' },
      { virtual_path: '20300102zx0007a1.jpg', local_path: 'old-back.jpg' },
      { virtual_path: '20300102zx0007b0.jpg', local_path: 'old-electronic.jpg' },
      { virtual_path: 'inbox/new-front.jpg', local_path: 'new-front.jpg' },
      { virtual_path: 'inbox/new-back.jpg', local_path: 'new-back.jpg' },
      { virtual_path: 'inbox/new-electronic.jpg', local_path: 'new-electronic.jpg' },
    );
    expect(resolveMappingTransitions(source, [
      { from: '20300102zx0007a0.jpg', to: null },
      { from: 'inbox/new-front.jpg', to: '20300102zx0007a0.jpg' },
      { from: 'inbox/new-back.jpg', to: '20300102zx0007a1.jpg' },
      { from: 'inbox/new-electronic.jpg', to: '20300102zx0007b0.jpg' },
    ])).toEqual([
      { from: '20300102zx0007a0.jpg', to: null },
      { from: 'inbox/new-front.jpg', to: '20300102zx0007a2.jpg' },
      { from: 'inbox/new-back.jpg', to: '20300102zx0007a3.jpg' },
      { from: 'inbox/new-electronic.jpg', to: '20300102zx0007b1.jpg' },
    ]);
  });

  it('appends attachments after the highest surviving c number and permits reusing a removed tail', () => {
    const withGap = mapping(
      { virtual_path: '20300102zx0007c1.pdf', local_path: 'one.pdf' },
      { virtual_path: 'inbox/new.png', local_path: 'new.png' },
    );
    expect(resolveMappingTransitions(withGap, [{ from: 'inbox/new.png', to: '20300102zx0007c0.png' }])[0].to).toBe('20300102zx0007c2.png');
    const tailRemoved = mapping(
      { virtual_path: '20300102zx0007c1.pdf', local_path: 'one.pdf' },
      { virtual_path: 'inbox/again.pdf', local_path: 'again.pdf' },
    );
    expect(resolveMappingTransitions(tailRemoved, [{ from: 'inbox/again.pdf', to: '20300102zx0007c0.pdf' }])[0].to).toBe('20300102zx0007c2.pdf');
    expect(resolveMappingTransitions(mapping({ virtual_path: 'inbox/reset.pdf', local_path: 'reset.pdf' }), [{ from: 'inbox/reset.pdf', to: '20300102zx0007c0.pdf' }])[0].to).toBe('20300102zx0007c0.pdf');
  });

  it('assigns one cross-extension attachment sequence within a single operation', () => {
    const source = mapping(
      { virtual_path: 'inbox/first.txt', local_path: 'first.txt' },
      { virtual_path: 'inbox/second.bin', local_path: 'second.bin' },
    );
    expect(resolveMappingTransitions(source, [
      { from: 'inbox/first.txt', to: '20300102zx0007c0.txt' },
      { from: 'inbox/second.bin', to: '20300102zx0007c0.bin' },
    ]).map((item) => item.to)).toEqual(['20300102zx0007c0.txt', '20300102zx0007c1.bin']);
  });

  it('ignore and unignore encode the source path in their temporary namespace', () => {
    const pending = mapping({ virtual_path: 'inbox/folder/a.png', local_path: 'folder/a.png' });
    const ignored = ignoreMappings(pending, catalog([['folder/a.png', 1]]), ['inbox/folder/a.png']);
    expect(ignored.entries[0].virtual_path).toBe('ignore/folder/a.png');
    expect(unignoreMappings(ignored, catalog([['folder/a.png', 1]]), ['ignore/folder/a.png']).entries[0].virtual_path).toBe('inbox/folder/a.png');
    expect(unignoreMappings(ignored, catalog([]), ['ignore/folder/a.png'])).toEqual(mapping());
  });

  it('drops absent temporary entries during reconciliation', () => {
    expect(reconcileMapping(mapping(
      { virtual_path: 'inbox/gone.png', local_path: 'gone.png' },
      { virtual_path: 'ignore/gone-too.png', local_path: 'gone-too.png' },
    ), catalog([])).entries).toEqual([]);
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
    expect(result).toEqual(mapping(
      { virtual_path: 'objects/target.png', local_path: 'replacement.png', size_bytes: 7 },
      { virtual_path: 'inbox/current.png', local_path: 'current.png', size_bytes: 3 },
    ));
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

  it('does not use an absent inbox entry as a rematch candidate', () => {
    expect(() => rematchMappings(mapping(
      { virtual_path: 'objects/target.png', local_path: 'gone.png' },
      { virtual_path: 'inbox/also-gone.png', local_path: 'also-gone.png' },
    ), catalog([]), [{
      targetVirtualPath: 'objects/target.png', candidateVirtualPath: 'inbox/also-gone.png',
    }])).toThrow(/present inbox/);
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
