// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import type { ResourceReviewRow } from '../api/types';
import { countMappingRows, rematchCandidates, rematchTargets, toMappingRows } from './mappingRows';

const capabilities = { ignore: false, unignore: false, release: false, fingerprint: false, rematchTarget: false, rematchCandidate: false };
const source = (overrides: Partial<ResourceReviewRow>): ResourceReviewRow => ({
  virtualPath: 'objects/a.png', localPath: '/a.png', state: 'mapped', present: true,
  sizeBytes: 1, fingerprints: [], uses: [], capabilities, ...overrides,
});

describe('review snapshot row adapter', () => {
  it('maps backend states without rejoining or reclassifying inventory', () => {
    const rows = toMappingRows([
      source({ state: 'pending', virtualPath: 'inbox/a.png' }),
      source({ state: 'ignored', virtualPath: 'ignore/a.png' }),
      source({ state: 'missing', virtualPath: 'objects/missing.png', present: false }),
      source({ state: 'local_only', virtualPath: null }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['inbox', 'ignored', 'missing', 'local_only']);
    expect(countMappingRows(rows)).toEqual({ paired: 0, inbox: 1, ignored: 1, missing: 1, local_only: 1 });
  });

  it('derives rematch lists only from authoritative capabilities', () => {
    const rows = toMappingRows([
      source({ state: 'missing', virtualPath: 'objects/target.png', capabilities: { ...capabilities, rematchTarget: true } }),
      source({ state: 'pending', virtualPath: 'inbox/candidate.png', capabilities: { ...capabilities, rematchCandidate: true } }),
      source({ state: 'pending', virtualPath: 'inbox/not-authorized.png' }),
    ]);
    expect(rematchTargets(rows).map((entry) => entry.virtual_path)).toEqual(['objects/target.png']);
    expect(rematchCandidates(rows).map((entry) => entry.virtual_path)).toEqual(['inbox/candidate.png']);
  });
});
