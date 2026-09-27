// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import { basename, fileKind, isImageResource, isPendingInbox, middleEllipsisPath, parentFolder } from './resourcePaths';

describe('resource path helpers', () => {
  it('accepts image resource extensions case-insensitively', () => {
    for (const path of ['inbox/a.png', 'inbox/b.JPG', 'x/c.svg', 'x/d.webp', 'x/e.avif']) expect(isImageResource(path)).toBe(true);
  });

  it('rejects non-image resources', () => {
    for (const path of ['inbox/scan.pdf', 'inbox/notes.txt', 'inbox/archive.zip', 'inbox/no-extension']) expect(isImageResource(path)).toBe(false);
  });

  it('derives basename, parent folder, and middle ellipsis display', () => {
    expect(basename('inbox/2026/scan.pdf')).toBe('scan.pdf');
    expect(parentFolder('inbox/2026/scan.pdf')).toBe('inbox/2026');
    expect(parentFolder('rootless.png')).toBe('');
    expect(middleEllipsisPath('inbox/2026/scan.pdf')).toBe('inbox/…/scan.pdf');
    expect(middleEllipsisPath('rootless.png')).toBe('rootless.png');
  });

  it('derives uppercase file kinds while rejecting absent or hidden-name extensions', () => {
    expect(fileKind('inbox/scan.pdf')).toBe('PDF');
    expect(fileKind('inbox/photo.jpeg')).toBe('JPEG');
    expect(fileKind('inbox/no-extension')).toBe('');
    expect(fileKind('inbox/.hidden')).toBe('');
  });

  it('classifies only the inbox prefix as pending inbox', () => {
    expect(isPendingInbox('inbox/a.png')).toBe(true);
    expect(isPendingInbox('objects/inbox/a.png')).toBe(false);
  });
});
