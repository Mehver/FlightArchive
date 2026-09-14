// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization of the resource picker's shared presentation helpers:
 * image detection (thumbnail vs generic file icon), file-manager name /
 * location / kind derivation, and the single filtered+ordered entry list
 * both picker views paginate over.
 */

import { describe, expect, it } from 'vitest';
import type { MappingEntry } from '../rfg/api';
import {
  fileKind,
  filterResourceEntries,
  isImageResource,
  isUnclassified,
  leafName,
  parentFolder,
} from './resourcePicker';

const entry = (virtual_path: string): MappingEntry => ({ virtual_path, local_path: `/local/${virtual_path}` });

describe('isImageResource', () => {
  it('accepts the thumbnail-served raster extensions and SVG', () => {
    for (const path of ['inbox/a.png', 'inbox/b.JPG', 'x/c.svg', 'x/d.webp', 'x/e.avif']) {
      expect(isImageResource(path)).toBe(true);
    }
  });

  it('rejects every non-image file', () => {
    for (const path of ['inbox/scan.pdf', 'inbox/notes.txt', 'inbox/archive.zip', 'inbox/no-extension']) {
      expect(isImageResource(path)).toBe(false);
    }
  });
});

describe('leafName / parentFolder / fileKind', () => {
  it('splits the display name and the location context', () => {
    expect(leafName('inbox/2026/scan.pdf')).toBe('scan.pdf');
    expect(parentFolder('inbox/2026/scan.pdf')).toBe('inbox/2026');
    expect(parentFolder('rootless.png')).toBe('');
  });

  it('derives the uppercase kind from the extension', () => {
    expect(fileKind('inbox/scan.pdf')).toBe('PDF');
    expect(fileKind('inbox/photo.jpeg')).toBe('JPEG');
    expect(fileKind('inbox/no-extension')).toBe('');
    expect(fileKind('inbox/.hidden')).toBe('');
  });
});

describe('filterResourceEntries', () => {
  const entries = [
    entry('objects/def/pass.png'),
    entry('inbox/zzz.pdf'),
    entry('objects/abc/logo.svg'),
    entry('inbox/aaa.png'),
  ];

  it('orders unclassified inbox entries first, then alphabetically', () => {
    expect(filterResourceEntries(entries, false, '').map((item) => item.virtual_path)).toEqual([
      'inbox/aaa.png',
      'inbox/zzz.pdf',
      'objects/abc/logo.svg',
      'objects/def/pass.png',
    ]);
  });

  it('keeps only images when the image-only contract applies', () => {
    expect(filterResourceEntries(entries, true, '').map((item) => item.virtual_path)).toEqual([
      'inbox/aaa.png',
      'objects/abc/logo.svg',
      'objects/def/pass.png',
    ]);
  });

  it('matches the search query case-insensitively against the full path', () => {
    expect(filterResourceEntries(entries, false, 'LOGO').map((item) => item.virtual_path)).toEqual(['objects/abc/logo.svg']);
    expect(filterResourceEntries(entries, false, 'inbox/').map((item) => item.virtual_path)).toEqual(['inbox/aaa.png', 'inbox/zzz.pdf']);
  });

  it('does not mutate the input array', () => {
    const before = entries.map((item) => item.virtual_path);
    filterResourceEntries(entries, false, '');
    expect(entries.map((item) => item.virtual_path)).toEqual(before);
  });

  it('classifies only the inbox prefix as unclassified', () => {
    expect(isUnclassified('inbox/a.png')).toBe(true);
    expect(isUnclassified('objects/inbox/a.png')).toBe(false);
  });
});
