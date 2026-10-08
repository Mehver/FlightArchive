import { describe, expect, it } from 'vitest';
import { fingerprintTargets, supportedFingerprintAlgorithms } from './fingerprints';
import { toMappingRows } from './mappingRows';

describe('resource-only fingerprint eligibility', () => {
  it('offers every present stable mapping without business usage', () => {
    const targets = fingerprintTargets(toMappingRows([{ virtualPath: 'objects/a.png', localPath: 'a.png', state: 'mapped', present: true, sizeBytes: 1, entry: { virtual_path: 'objects/a.png', local_path: 'a.png', sha256: 'saved' } }]));
    expect(targets).toHaveLength(1);
    expect(targets[0].stored).toEqual(['sha256']);
    expect(supportedFingerprintAlgorithms('a.pdf')).toEqual(['crc32', 'md5', 'sha256']);
  });
});
