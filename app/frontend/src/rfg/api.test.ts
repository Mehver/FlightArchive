// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization tests for the resource URL builders shared by every
 * RFG request in the app: each virtual path segment is percent-encoded
 * independently (slashes stay path separators) and /res/ serves originals.
 * the backend fingerprint contract and must not drift.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HASH_ALGORITHMS, PERCEPTUAL_ALGORITHMS, resourceUrl, thumbnailUrl, rfgClient } from './api';

afterEach(() => vi.restoreAllMocks());

describe('resource URLs', () => {
  it('keeps original access explicit and routes display through the thumbnail relay', () => {
    const path = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png';
    expect(resourceUrl(path)).toBe('/res/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png');
    expect(thumbnailUrl(path, 0.125)).toBe('/api/thumbnails/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png?scale=0.125');
  });

  it('percent-encodes each segment while keeping slashes as separators', () => {
    expect(resourceUrl('inbox/my ticket #1.png')).toBe('/res/inbox/my%20ticket%20%231.png');
    expect(thumbnailUrl('inbox/100%.png', 0.5)).toBe('/api/thumbnails/inbox/100%25.png?scale=0.5');
    expect(resourceUrl('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png')).toBe(
      '/res/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    );
  });

  it('encodes reserved characters inside a segment instead of letting them reshape the path', () => {
    // '?' and '#' would otherwise start query/fragment parts of the URL.
    expect(resourceUrl('inbox/a?b#c.png')).toBe('/res/inbox/a%3Fb%23c.png');
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

describe('public RFG HTTP client', () => {
  it('uses only the documented catalog, map, hash, and resource routes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/meta/local')) return new Response(JSON.stringify({ local_files: [] }), { status: 200 });
      if (url.endsWith('/meta/map')) return new Response(JSON.stringify({ entries: [] }), { status: 200, headers: { ETag: '"token"' } });
      if (url.endsWith('/hashes')) return new Response(JSON.stringify({ local_path: 'a', algorithm: 'sha256', profile: null, status: 'succeeded', value: 'hash', code: 'computed', detail: null, error: null }), { status: 200 });
      return new Response('', { status: 200 });
    });
    await rfgClient.getCatalog();
    expect((await rfgClient.getMapping()).etag).toBe('"token"');
    await rfgClient.putMapping({ entries: [] });
    await rfgClient.computeHash({ local_path: 'a', algorithm: 'sha256' });
    await rfgClient.getResource('folder/a b.bin');
    await rfgClient.headResource('folder/a b.bin');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/v1/meta/local', '/api/v1/meta/map', '/api/v1/meta/map', '/api/v1/hashes', '/res/folder/a%20b.bin', '/res/folder/a%20b.bin',
    ]);
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    expect(fetchMock.mock.calls[2][1]?.headers).not.toHaveProperty('If-Match');
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[4][1]).toMatchObject({ method: 'GET' });
    expect(fetchMock.mock.calls[5][1]).toMatchObject({ method: 'HEAD' });
    expect(fetchMock.mock.calls.every(([url]) => !String(url).startsWith('/api/resources'))).toBe(true);
  });
});
