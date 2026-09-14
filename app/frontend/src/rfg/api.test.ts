// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization tests for the resource URL builders shared by every
 * resource <img> in the app: each virtual path segment is percent-encoded
 * independently (slashes stay path separators), /res/ serves originals and
 * /images/ serves cached WebP thumbnails. The algorithm constants mirror
 * the backend fingerprint contract and must not drift.
 */

import { describe, expect, it } from 'vitest';
import { HASH_ALGORITHMS, imageUrl, PERCEPTUAL_ALGORITHMS, resourceUrl, rfg } from './api';

describe('resourceUrl / imageUrl', () => {
  it('routes originals through /res/ and thumbnails through /images/', () => {
    const path = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png';
    expect(resourceUrl(path)).toBe('/res/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png');
    expect(imageUrl(path)).toBe('/images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png');
  });

  it('percent-encodes each segment while keeping slashes as separators', () => {
    expect(resourceUrl('inbox/my ticket #1.png')).toBe('/res/inbox/my%20ticket%20%231.png');
    expect(imageUrl('inbox/100%.png')).toBe('/images/inbox/100%25.png');
    expect(resourceUrl('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png')).toBe(
      '/res/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    );
  });

  it('encodes reserved characters inside a segment instead of letting them reshape the path', () => {
    // '?' and '#' would otherwise start query/fragment parts of the URL.
    expect(resourceUrl('inbox/a?b#c.png')).toBe('/res/inbox/a%3Fb%23c.png');
  });

  it('exposes the same builders on the rfg client facade', () => {
    expect(rfg.resourceUrl).toBe(resourceUrl);
    expect(rfg.imageUrl).toBe(imageUrl);
  });
});

describe('hash algorithm constants', () => {
  it('mirrors exactly the six backend-supported algorithms in order', () => {
    expect(HASH_ALGORITHMS).toEqual(['crc32', 'md5', 'sha256', 'ahash', 'dhash', 'phash']);
  });

  it('marks exactly the perceptual image hashes', () => {
    expect(PERCEPTUAL_ALGORITHMS).toEqual(['ahash', 'dhash', 'phash']);
    expect(PERCEPTUAL_ALGORITHMS.every((algorithm) => HASH_ALGORITHMS.includes(algorithm))).toBe(true);
  });
});
