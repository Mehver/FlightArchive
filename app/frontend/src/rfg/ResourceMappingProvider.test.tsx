// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { HashTerminalResult, RfgClient } from './api';
import { ResourceMappingProvider, useResourceMapping } from './ResourceMappingProvider';

function setup(hashImpl?: RfgClient['computeHash']) {
  let document = { entries: [{ virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 }] };
  const client: RfgClient = {
    getCatalog: vi.fn(async () => ({ local_files: [{ local_path: 'a.bin', size_bytes: 1 }] })),
    getMapping: vi.fn(async () => ({ document, etag: 'display-only' })),
    putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
    computeHash: hashImpl ?? vi.fn(async ({ local_path, algorithm }) => ({ local_path, algorithm, profile: null, status: 'succeeded', value: `${algorithm}-value`, code: 'computed', detail: null, error: null } as HashTerminalResult)),
    getResource: vi.fn(), headResource: vi.fn(),
  };
  const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
  return { client, result: renderHook(() => useResourceMapping(), { wrapper }).result };
}

describe('ResourceMappingProvider', () => {
  it.each([
    {
      name: 'materialize',
      entries: [{ virtual_path: 'inbox/folder/a.png', local_path: 'folder/a.png' }],
      local: [['folder/a.png', 3]] as const,
      run: (value: ReturnType<typeof useResourceMapping>) => value.materialize('inbox/folder/a.png', 'objects/a.png'),
      expected: [{ virtual_path: 'objects/a.png', local_path: 'folder/a.png', size_bytes: 3 }],
    },
    {
      name: 'ignore',
      entries: [{ virtual_path: 'inbox/folder/a.png', local_path: 'folder/a.png' }],
      local: [['folder/a.png', 3]] as const,
      run: (value: ReturnType<typeof useResourceMapping>) => value.ignore(['inbox/folder/a.png']),
      expected: [{ virtual_path: 'ignore/folder/a.png', local_path: 'folder/a.png', size_bytes: 3 }],
    },
    {
      name: 'unignore',
      entries: [{ virtual_path: 'ignore/folder/a.png', local_path: 'folder/a.png' }],
      local: [['folder/a.png', 3]] as const,
      run: (value: ReturnType<typeof useResourceMapping>) => value.unignore(['ignore/folder/a.png']),
      expected: [{ virtual_path: 'inbox/folder/a.png', local_path: 'folder/a.png', size_bytes: 3 }],
    },
    {
      name: 'release',
      entries: [{ virtual_path: 'objects/a.png', local_path: 'folder/a.png', sha256: 'old' }],
      local: [['folder/a.png', 3]] as const,
      run: (value: ReturnType<typeof useResourceMapping>) => value.release(['objects/a.png']),
      expected: [{ virtual_path: 'inbox/folder/a.png', local_path: 'folder/a.png', size_bytes: 3 }],
    },
    {
      name: 'explicit rematch',
      entries: [
        { virtual_path: 'objects/a.png', local_path: 'old.png', sha256: 'old' },
        { virtual_path: 'inbox/new.png', local_path: 'new.png' },
      ],
      local: [['old.png', 2], ['new.png', 3]] as const,
      run: (value: ReturnType<typeof useResourceMapping>) => value.rematch([{ targetVirtualPath: 'objects/a.png', candidateVirtualPath: 'inbox/new.png' }]),
      expected: [{ virtual_path: 'objects/a.png', local_path: 'new.png', size_bytes: 3 }],
    },
  ])('writes the $name UI flow through the direct mapping client', async ({ entries, local, run, expected }) => {
    let document = { entries };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => ({ local_files: local.map(([local_path, size_bytes]) => ({ local_path, size_bytes })) })),
      getMapping: vi.fn(async () => ({ document, etag: 'ignored' })),
      putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => run(result.current));
    expect(client.putMapping).toHaveBeenCalledTimes(1);
    expect((client.putMapping as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ entries: expected });
    expect(JSON.stringify((client.putMapping as ReturnType<typeof vi.fn>).mock.calls[0])).not.toContain('If-Match');
  });

  it('fingerprints unreferenced stable mappings sequentially and writes without If-Match or wrappers', async () => {
    const active: string[] = [];
    let concurrent = 0;
    const { client, result } = setup(vi.fn(async ({ local_path, algorithm }, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      concurrent += 1; expect(concurrent).toBe(1); active.push(algorithm);
      await Promise.resolve(); concurrent -= 1;
      return { local_path, algorithm, profile: null, status: 'succeeded', value: algorithm, code: 'computed', detail: null, error: null } as HashTerminalResult;
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.fingerprint(['objects/a.bin'], ['sha256', 'md5']));
    expect(active).toEqual(['sha256', 'md5']);
    expect(result.current.fingerprintProgress).toMatchObject({ status: 'succeeded', completed: 2, total: 2 });
    expect(client.putMapping).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((client.putMapping as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('If-Match');
  });

  it('cancels the active hash and starts no further jobs', async () => {
    const started: string[] = [];
    const { client, result } = setup(vi.fn(({ local_path, algorithm }, signal?: AbortSignal) => new Promise<HashTerminalResult>((resolve, reject) => {
      started.push(algorithm);
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      void resolve; void local_path;
    })));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let work!: Promise<unknown>;
    act(() => { work = result.current.fingerprint(['objects/a.bin'], ['sha256', 'md5']); });
    await waitFor(() => expect(started).toEqual(['sha256']));
    act(() => result.current.cancelFingerprint());
    await act(() => work);
    expect(started).toEqual(['sha256']);
    expect(result.current.fingerprintProgress.status).toBe('cancelled');
    expect(client.putMapping).not.toHaveBeenCalled();
  });

  it('validates the entire selection before starting any hash', async () => {
    const { client, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(act(() => result.current.fingerprint(['objects/a.bin', 'inbox/missing.bin'], ['sha256']))).rejects.toThrow('fingerprint targets');
    expect(client.computeHash).not.toHaveBeenCalled();
  });

  it('cancels during the final refresh and publishes no completed hashes', async () => {
    let hashFinished = false;
    const { client, result } = setup(vi.fn(async ({ local_path, algorithm }) => {
      hashFinished = true;
      return { local_path, algorithm, profile: null, status: 'succeeded', value: 'done', code: 'computed', detail: null, error: null } as HashTerminalResult;
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let finalFetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { finalFetchStarted = resolve; });
    (client.getCatalog as ReturnType<typeof vi.fn>).mockImplementation((_signal?: AbortSignal) => {
      if (!hashFinished) return Promise.resolve({ local_files: [{ local_path: 'a.bin', size_bytes: 1 }] });
      finalFetchStarted();
      return new Promise((_resolve, reject) => _signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    let work!: Promise<unknown>;
    act(() => { work = result.current.fingerprint(['objects/a.bin'], ['sha256']); });
    await started;
    act(() => result.current.cancelFingerprint());
    await act(() => work);
    expect(client.putMapping).not.toHaveBeenCalled();
    expect(result.current.fingerprintProgress.status).toBe('cancelled');
  });
});
