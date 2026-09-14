// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization tests for the frontend mirror of the server-authorized
 * fingerprint eligibility rule. These tests characterize the flight-reference
 * helper; the page also includes airline-logo references in its global business
 * reference index. Inbox and local-only rows are hidden; calculation targets
 * exist only while the source file is present.
 */

import { describe, expect, it } from 'vitest';
import type { FlightRecord } from '../api/types';
import { HASH_ALGORITHMS, type MappingEntry } from '../rfg/api';
import {
  chunkVirtualPaths,
  directFlightReferenceCounts,
  FINGERPRINT_MAX_PATHS_PER_REQUEST,
  fingerprintRowState,
  fingerprintTargets,
  storedFingerprintAlgorithms,
  supportedFingerprintAlgorithms,
  supportsPerceptualFingerprint,
  targetsMissingAlgorithms,
} from './fingerprints';
import { buildMappingRows, type MappingRow } from './mappingJoin';

function makeFlight(overrides: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: 'flight-1',
    flightNumber: '1',
    airlineCode: 'CA',
    departureAirport: 'PEK',
    arrivalAirport: 'SHA',
    departureTerminal: null,
    arrivalTerminal: null,
    departureDate: '2026-01-01',
    departureTime: null,
    arrivalTime: null,
    aircraftTypeIcao: null,
    registration: null,
    seat: null,
  
    notes: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    paperBoardingPassFrontResourcePath: null,
    paperBoardingPassBackResourcePath: null,
    electronicBoardingPassResourcePath: null,
    attachmentResourcePaths: [],
    boardingPassColor: null,
    ...overrides,
  };
}

function entry(virtualPath: string, localPath: string, hashes: Partial<MappingEntry> = {}): MappingEntry {
  return { virtual_path: virtualPath, local_path: localPath, ...hashes };
}

const FRONT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png';
const BACK = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png';
const ELECTRONIC = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png';
const ATTACHMENT = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.png';
const LOGO = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.svg';

describe('directFlightReferenceCounts', () => {
  it('counts exactly the three boarding-pass fields and attachments', () => {
    const counts = directFlightReferenceCounts([
      makeFlight({
        paperBoardingPassFrontResourcePath: FRONT,
        paperBoardingPassBackResourcePath: BACK,
        electronicBoardingPassResourcePath: ELECTRONIC,
        attachmentResourcePaths: [ATTACHMENT],
      }),
    ]);
    expect(counts.get(FRONT)).toBe(1);
    expect(counts.get(BACK)).toBe(1);
    expect(counts.get(ELECTRONIC)).toBe(1);
    expect(counts.get(ATTACHMENT)).toBe(1);
    expect(counts.size).toBe(4);
  });

  it('counts every non-inbox object held by a direct flight field', () => {
    const counts = directFlightReferenceCounts([
      makeFlight({
        paperBoardingPassFrontResourcePath: BACK,
        paperBoardingPassBackResourcePath: ATTACHMENT,
        electronicBoardingPassResourcePath: LOGO,
        attachmentResourcePaths: [FRONT, LOGO, 'inbox/raw.png'],
      }),
    ]);
    expect(counts.get(BACK)).toBe(1);
    expect(counts.get(ATTACHMENT)).toBe(1);
    expect(counts.get(LOGO)).toBe(1);
    expect(counts.get(FRONT)).toBe(1);
    expect(counts.size).toBe(4);
  });

  it('ignores null and non-string field values', () => {
    const counts = directFlightReferenceCounts([makeFlight()]);
    expect(counts.size).toBe(0);
  });

  it('counts a path once per flight even when the flight lists it repeatedly', () => {
    const shared = ATTACHMENT;
    const counts = directFlightReferenceCounts([
      makeFlight({ attachmentResourcePaths: [shared, shared] }),
      makeFlight({ id: 'flight-2', attachmentResourcePaths: [shared] }),
    ]);
    expect(counts.get(shared)).toBe(2);
  });

  it('accumulates references across flights', () => {
    const counts = directFlightReferenceCounts([
      makeFlight({ paperBoardingPassFrontResourcePath: FRONT }),
      makeFlight({ id: 'flight-2', paperBoardingPassFrontResourcePath: FRONT }),
      makeFlight({ id: 'flight-3' }),
    ]);
    expect(counts.get(FRONT)).toBe(2);
  });
});

describe('storedFingerprintAlgorithms', () => {
  it('lists exactly the algorithms with a non-empty stored value, in protocol order', () => {
    const stored = storedFingerprintAlgorithms(
      entry(FRONT, 'front.png', { sha256: 'abc', crc32: '12', phash: 'ff', md5: '' }),
    );
    expect(stored).toEqual(['crc32', 'sha256', 'phash']);
    expect(HASH_ALGORITHMS).toEqual(['crc32', 'md5', 'sha256', 'ahash', 'dhash', 'phash']);
  });

  it('is empty when the entry carries no hashes', () => {
    expect(storedFingerprintAlgorithms(entry(FRONT, 'front.png'))).toEqual([]);
  });
});

describe('fingerprintRowState', () => {
  const references = directFlightReferenceCounts([
    makeFlight({ paperBoardingPassFrontResourcePath: FRONT, attachmentResourcePaths: [ATTACHMENT] }),
  ]);

  function rowFor(virtualPath: string, localPath: string, localPaths: string[]): MappingRow {
    const rows = buildMappingRows(localPaths, [entry(virtualPath, localPath)]);
    return rows.find((row) => row.virtualPath === virtualPath) ?? rows[0];
  }

  it('hides inbox rows even when their path is referenced', () => {
    const inboxReferences = new Map([['inbox/front.png', 3]]);
    const row = rowFor('inbox/front.png', 'front.png', ['front.png']);
    expect(fingerprintRowState(row, inboxReferences)).toEqual({ kind: 'hidden' });
  });

  it('hides local_only rows', () => {
    const [row] = buildMappingRows(['stray.png'], []);
    expect(fingerprintRowState(row, references)).toEqual({ kind: 'hidden' });
  });

  it('marks object rows without references as unreferenced', () => {
    const row = rowFor(BACK, 'back.png', ['back.png']);
    expect(fingerprintRowState(row, references)).toEqual({ kind: 'unreferenced' });
  });

  it('marks referenced paired rows as calculable with their reference count', () => {
    const row = rowFor(FRONT, 'front.png', ['front.png']);
    expect(fingerprintRowState(row, references)).toEqual({ kind: 'referenced', referenceCount: 1, calculable: true });
  });

  it('keeps referenced missing rows visible but not calculable', () => {
    const row = rowFor(FRONT, 'front.png', []);
    expect(fingerprintRowState(row, references)).toEqual({ kind: 'referenced', referenceCount: 1, calculable: false });
  });

  it('accumulates the reference count shown for a row', () => {
    const many = directFlightReferenceCounts([
      makeFlight({ paperBoardingPassFrontResourcePath: FRONT }),
      makeFlight({ id: 'flight-2', paperBoardingPassFrontResourcePath: FRONT }),
    ]);
    const row = rowFor(FRONT, 'front.png', ['front.png']);
    expect(fingerprintRowState(row, many)).toEqual({ kind: 'referenced', referenceCount: 2, calculable: true });
  });
});

describe('fingerprintTargets', () => {
  it('resolves only present, referenced object entries as calculable targets', () => {
    const referenced = entry(FRONT, 'front.png', { crc32: 'aa', md5: 'bb' });
    const rows = buildMappingRows(
      ['front.png', 'back.png', 'inbox.png'],
      [
        referenced,
        entry(BACK, 'back.png'), // present but unreferenced
        entry(ATTACHMENT, 'gone-attachment.png'), // referenced but missing
        entry('inbox/inbox.png', 'inbox.png'),
      ],
    );
    const references = directFlightReferenceCounts([
      makeFlight({ paperBoardingPassFrontResourcePath: FRONT, attachmentResourcePaths: [ATTACHMENT] }),
    ]);
    const targets = fingerprintTargets(rows, references);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ virtualPath: FRONT, localPath: 'front.png', stored: ['crc32', 'md5'] });
    expect(targets[0].entry).toBe(referenced);
  });

  it('returns no targets without references or rows', () => {
    expect(fingerprintTargets([], new Map())).toEqual([]);
    const rows = buildMappingRows(['front.png'], [entry(FRONT, 'front.png')]);
    expect(fingerprintTargets(rows, new Map())).toEqual([]);
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
