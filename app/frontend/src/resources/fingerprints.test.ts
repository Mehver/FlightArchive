// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization tests for the frontend mirror of the server-authorized
 * fingerprint eligibility rule. The page supplies reference counts from its
 * backend-authoritative usage and capabilities. Inbox and local-only
 * rows are hidden; calculation targets exist only while the source is present.
 */

import { describe, expect, it } from 'vitest';
import { HASH_ALGORITHMS } from '../rfg/api';
import type { ResourceReviewRow } from '../api/types';
import {
  chunkVirtualPaths,
  FINGERPRINT_MAX_PATHS_PER_REQUEST,
  fingerprintRowState,
  fingerprintTargets,
  supportedFingerprintAlgorithms,
  supportsPerceptualFingerprint,
  targetsMissingAlgorithms,
} from './fingerprints';
import { toMappingRows, type MappingRow } from './mappingRows';

const FRONT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png';
const BACK = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png';
const ATTACHMENT = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.png';
const capabilities = { ignore: false, unignore: false, release: false, fingerprint: false, rematchTarget: false, rematchCandidate: false };
const flightUse = { kind: 'flight' as const, id: 'f1', airlineCode: 'SF', flightNumber: '12', departureDate: '2026-01-02', role: 'attachment' as const };

function row(overrides: Partial<ResourceReviewRow>): MappingRow {
  return toMappingRows([{ virtualPath: FRONT, localPath: 'front.png', state: 'mapped', present: true, sizeBytes: null, fingerprints: [], uses: [], capabilities, ...overrides }])[0];
}

describe('fingerprintRowState', () => {
  it('hides inbox rows even when their path is referenced', () => {
    expect(fingerprintRowState(row({ virtualPath: 'inbox/front.png', state: 'pending', uses: [flightUse] }))).toEqual({ kind: 'hidden' });
  });

  it('hides local_only rows', () => {
    expect(fingerprintRowState(row({ virtualPath: null, state: 'local_only' }))).toEqual({ kind: 'hidden' });
  });

  it('marks object rows without references as unreferenced', () => {
    expect(fingerprintRowState(row({ virtualPath: BACK }))).toEqual({ kind: 'unreferenced' });
  });

  it('marks referenced paired rows as calculable with their reference count', () => {
    expect(fingerprintRowState(row({ uses: [flightUse], capabilities: { ...capabilities, fingerprint: true } }))).toEqual({ kind: 'referenced', referenceCount: 1, calculable: true });
  });

  it('keeps referenced missing rows visible but not calculable', () => {
    expect(fingerprintRowState(row({ state: 'missing', present: false, uses: [flightUse] }))).toEqual({ kind: 'referenced', referenceCount: 1, calculable: false });
  });

  it('accumulates the reference count shown for a row', () => {
    expect(fingerprintRowState(row({ uses: [flightUse, { ...flightUse, id: 'f2' }], capabilities: { ...capabilities, fingerprint: true } }))).toEqual({ kind: 'referenced', referenceCount: 2, calculable: true });
  });
});

describe('fingerprintTargets', () => {
  it('resolves only present, referenced object entries as calculable targets', () => {
    const rows = [
      row({ fingerprints: ['crc32', 'md5'], uses: [flightUse], capabilities: { ...capabilities, fingerprint: true } }),
      row({ virtualPath: BACK }),
      row({ virtualPath: ATTACHMENT, state: 'missing', present: false, uses: [flightUse] }),
      row({ virtualPath: 'inbox/inbox.png', state: 'pending' }),
    ];
    const targets = fingerprintTargets(rows);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ virtualPath: FRONT, localPath: 'front.png', stored: ['crc32', 'md5'] });
    expect(targets[0].entry.virtual_path).toBe(FRONT);
  });

  it('returns no targets without references or rows', () => {
    expect(fingerprintTargets([])).toEqual([]);
    expect(fingerprintTargets([row({})])).toEqual([]);
  });
});

describe('targetsMissingAlgorithms', () => {
  const target = (stored: readonly (typeof HASH_ALGORITHMS)[number][]) => ({ stored });

  it('keeps targets missing at least one requested algorithm', () => {
    const targets = [target(['crc32']), target(['crc32', 'md5']), target([])];
    expect(targetsMissingAlgorithms(targets, ['crc32', 'md5'])).toEqual([targets[0], targets[2]]);
  });

  it('drops every target when no algorithms are requested', () => {
    expect(targetsMissingAlgorithms([target([])], [])).toEqual([]);
  });
});

describe('chunkVirtualPaths', () => {
  it('splits paths into backend-capped chunks, preserving order', () => {
    const paths = Array.from({ length: FINGERPRINT_MAX_PATHS_PER_REQUEST * 2 + 1 }, (_, index) => `p${index}`);
    const chunks = chunkVirtualPaths(paths);
    expect(chunks.map((chunk) => chunk.length)).toEqual([32, 32, 1]);
    expect(chunks.flat()).toEqual(paths);
    expect(FINGERPRINT_MAX_PATHS_PER_REQUEST).toBe(32);
  });

  it('returns a single chunk at exactly the cap and nothing for empty input', () => {
    const paths = Array.from({ length: 32 }, (_, index) => `p${index}`);
    expect(chunkVirtualPaths(paths)).toEqual([paths]);
    expect(chunkVirtualPaths([])).toEqual([]);
  });

  it('honours a custom chunk size', () => {
    expect(chunkVirtualPaths(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });
});

describe('perceptual fingerprint support', () => {
  it('allows known raster images but excludes SVG and unknown types', () => {
    expect(supportsPerceptualFingerprint('logo.PNG')).toBe(true);
    expect(supportsPerceptualFingerprint('logo.svg')).toBe(false);
    expect(supportsPerceptualFingerprint('file.pdf')).toBe(false);
    expect(supportedFingerprintAlgorithms('logo.svg')).toEqual(['crc32', 'md5', 'sha256']);
    expect(supportedFingerprintAlgorithms('logo.jpeg')).toHaveLength(6);
  });
});
