// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import { selectThumbnailScale } from './thumbnailScale';

describe('selectThumbnailScale', () => {
  it('is deterministic and applies the documented compressed-byte hint', () => {
    const request = { sourceWidth: 4000, sourceHeight: 3000, sourceBytes: 32 * 1024 * 1024, maxDimension: 1024 };
    expect(selectThumbnailScale(request)).toBe(0.25);
    expect(selectThumbnailScale(request)).toBe(0.25);
  });

  it('uses crop dimensions for requested quality but source dimensions for mandatory pixel safety', () => {
    expect(selectThumbnailScale({ sourceWidth: 14_000, sourceHeight: 10_000, sourceBytes: 500_000, crop: { width: 9_541, height: 3_897 }, maxDimension: 512 })).toBe(0.0625);
    expect(selectThumbnailScale({ sourceWidth: 14_000, sourceHeight: 10_000, sourceBytes: 500_000, crop: { width: 8, height: 4 }, maxDimension: 1024 })).toBe(0.125);
  });

  it('never requests a huge preview for a small compressed huge image', () => {
    expect(selectThumbnailScale({ sourceWidth: 32_000, sourceHeight: 5_000, sourceBytes: 64_000, maxDimension: 1280 })).toBe(0.0625);
  });

  it('uses the largest budget-permitted bin when crop quality is unreachable', () => {
    expect(selectThumbnailScale({ sourceWidth: 32_000, sourceHeight: 5_000, sourceBytes: 256 * 1024 * 1024, crop: { width: 16, height: 8 }, maxDimension: 1024 })).toBe(0.0625);
  });

  it.each([
    { sourceWidth: 0, sourceHeight: 10, sourceBytes: 10, maxDimension: 10 },
    { sourceWidth: 10.5, sourceHeight: 10, sourceBytes: 10, maxDimension: 10 },
    { sourceWidth: 10, sourceHeight: 10, sourceBytes: 0, maxDimension: 10 },
    { sourceWidth: 10, sourceHeight: 10, sourceBytes: 10, maxDimension: Number.NaN },
    { sourceWidth: 10, sourceHeight: 10, sourceBytes: 10, maxDimension: 10, crop: { width: 0, height: 1 } },
  ])('rejects invalid numeric input %#', (request) => {
    expect(() => selectThumbnailScale(request)).toThrow('invalid-thumbnail-scale-input');
  });

  it('keeps small images at scale one', () => {
    expect(selectThumbnailScale({ sourceWidth: 320, sourceHeight: 180, sourceBytes: 20_000, maxDimension: 512 })).toBe(1);
  });
});
