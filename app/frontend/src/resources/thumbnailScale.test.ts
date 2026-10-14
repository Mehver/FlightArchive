// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import { selectStudioThumbnailScale, selectThumbnailScale } from './thumbnailScale';

describe('selectThumbnailScale', () => {
  it('is deterministic and applies the documented compressed-byte hint', () => {
    const request = { sourceWidth: 4000, sourceHeight: 3000, sourceBytes: 32 * 1024 * 1024, qualityWidth: 4000, qualityHeight: 3000 };
    expect(selectThumbnailScale(request)).toBe(0.25);
    expect(selectThumbnailScale(request)).toBe(0.25);
  });

  it('uses fixed detail crop quality rather than consumer output dimensions', () => {
    const request = { sourceWidth: 14_000, sourceHeight: 10_000, sourceBytes: 500_000, qualityWidth: 9541, qualityHeight: 3897 };
    expect(selectThumbnailScale(request)).toBe(0.0625);
    expect(selectThumbnailScale(request)).toBe(0.0625);
    expect(selectThumbnailScale({ ...request, qualityWidth: 8, qualityHeight: 4 })).toBe(0.125);
  });

  it('selects the previous detail scale for the large production-shaped source', () => {
    expect(selectThumbnailScale({ sourceWidth: 14_000, sourceHeight: 10_000, sourceBytes: 84 * 1024 * 1024, qualityWidth: 11_200, qualityHeight: 4200 })).toBe(0.0625);
  });

  it('never requests a huge preview for a small compressed huge image', () => {
    expect(selectThumbnailScale({ sourceWidth: 32_000, sourceHeight: 5_000, sourceBytes: 64_000, qualityWidth: 32_000, qualityHeight: 5000 })).toBe(0.03125);
  });

  it('uses the largest budget-permitted bin when crop quality is unreachable', () => {
    expect(selectThumbnailScale({ sourceWidth: 32_000, sourceHeight: 5_000, sourceBytes: 256 * 1024 * 1024, qualityWidth: 16, qualityHeight: 8 })).toBe(0.0625);
  });

  it.each([
    { sourceWidth: 0, sourceHeight: 10, sourceBytes: 10, qualityWidth: 10, qualityHeight: 10 },
    { sourceWidth: 10.5, sourceHeight: 10, sourceBytes: 10, qualityWidth: 10, qualityHeight: 10 },
    { sourceWidth: 10, sourceHeight: 10, sourceBytes: 0, qualityWidth: 10, qualityHeight: 10 },
    { sourceWidth: 10, sourceHeight: 10, sourceBytes: 10, qualityWidth: 0, qualityHeight: 10 },
  ])('rejects invalid numeric input %#', (request) => {
    expect(() => selectThumbnailScale(request)).toThrow('invalid-thumbnail-scale-input');
  });

  it('keeps small images at scale one', () => {
    expect(selectThumbnailScale({ sourceWidth: 320, sourceHeight: 180, sourceBytes: 20_000, qualityWidth: 320, qualityHeight: 180 })).toBe(1);
  });
});

describe('selectStudioThumbnailScale', () => {
  it('uses the largest safe relay scale without applying the display byte hint', () => {
    expect(selectStudioThumbnailScale({ sourceWidth: 14_001, sourceHeight: 10_001 })).toBe(0.125);
    expect(selectStudioThumbnailScale({ sourceWidth: 4000, sourceHeight: 3000 })).toBe(0.5);
  });

  it('keeps ordinary studio images at their original scale', () => {
    expect(selectStudioThumbnailScale({ sourceWidth: 1600, sourceHeight: 900 })).toBe(1);
  });
});
