import { describe, expect, it } from 'vitest';
import type { ResourceInventoryRow } from '../rfg/mapping';
import { countMappingRows, rematchCandidates, rematchTargets, toMappingRows } from './mappingRows';

const row = (state: ResourceInventoryRow['state'], virtualPath: string | null, present = true): ResourceInventoryRow => ({
  state, virtualPath, present, localPath: `${state}.png`, sizeBytes: 1,
  entry: virtualPath ? { virtual_path: virtualPath, local_path: `${state}.png` } : null,
});

describe('resource inventory row adapter', () => {
  it('maps RFG inventory states and derives rematch eligibility locally', () => {
    const rows = toMappingRows([
      row('mapped', 'objects/live.png'), row('missing', 'objects/lost.png', false),
      row('pending', 'inbox/new.png'), row('ignored', 'ignore/old.png'), row('local_only', null),
    ]);
    expect(countMappingRows(rows)).toEqual({ paired: 1, inbox: 1, ignored: 1, missing: 1, local_only: 1 });
    expect(rematchTargets(rows).map((entry) => entry.virtual_path)).toEqual(['objects/lost.png']);
    expect(rematchCandidates(rows).map((entry) => entry.virtual_path)).toEqual(['inbox/new.png']);
  });
});
