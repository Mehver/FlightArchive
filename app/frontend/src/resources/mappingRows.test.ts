import { describe, expect, it } from 'vitest';
import type { ResourceInventoryRow } from '../rfg/mapping';
import { countMappingRows, rematchCandidates, rematchTargets, toMappingRows } from './mappingRows';

const row = (state: ResourceInventoryRow['state'], virtualPath: string, present = true): ResourceInventoryRow => ({
  state, virtualPath, present, localPath: `${state}.png`, sizeBytes: 1,
  entry: { virtual_path: virtualPath, local_path: `${state}.png` },
});

describe('resource inventory row adapter', () => {
  it('maps RFG inventory states and derives rematch eligibility locally', () => {
    const rows = toMappingRows([
      row('mapped', 'objects/live.png'), row('missing', 'objects/lost.png', false),
      row('pending', 'inbox/new.png'), row('ignored', 'ignore/old.png'),
    ]);
    expect(countMappingRows(rows)).toEqual({ paired: 1, inbox: 1, ignored: 1, missing: 1 });
    expect(rows).toHaveLength(4);
    expect(rematchTargets(rows).map((entry) => entry.virtual_path)).toEqual(['objects/lost.png']);
    expect(rematchCandidates(rows).map((entry) => entry.virtual_path)).toEqual(['inbox/new.png']);
  });

  it('keeps stable row identity when another inbox entry disappears', () => {
    const stable = row('mapped', 'objects/live.png');
    const withInbox = toMappingRows([row('pending', 'inbox/old.png'), stable]);
    const withoutInbox = toMappingRows([stable]);
    expect(withInbox.find((item) => item.virtualPath === stable.virtualPath)?.key).toBe('objects/live.png');
    expect(withoutInbox[0].key).toBe('objects/live.png');
  });
});
