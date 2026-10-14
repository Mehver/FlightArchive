// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { HashTerminalResult, RfgClient } from './api';
import { ResourceMappingMutationError, ResourceMappingProvider, useResourceMapping } from './ResourceMappingProvider';
import { FeedbackProvider, useFeedback } from '../feedback/FeedbackCenter';
import { LanguageProvider } from '../i18n';

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
  it('reports one startup failure through the shared stream under StrictMode', async () => {
    const failure = new Error('catalog unavailable');
    const client: RfgClient = {
      getCatalog: vi.fn(async () => { throw failure; }), getMapping: vi.fn(), putMapping: vi.fn(),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const activity = vi.fn(async () => { throw new Error('activity unavailable'); });
    vi.stubGlobal('fetch', activity);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode><LanguageProvider><FeedbackProvider><ResourceMappingProvider client={client}>{children}</ResourceMappingProvider></FeedbackProvider></LanguageProvider></StrictMode>
    );
    const { result, unmount } = renderHook(() => ({ resources: useResourceMapping(), feedback: useFeedback() }), { wrapper });
    await waitFor(() => expect(result.current.feedback.records).toHaveLength(1));
    expect(result.current.feedback.records[0]).toMatchObject({ code: 'resource-mapping-failed', finalState: 'failed' });
    expect(client.getCatalog).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledTimes(1);
    unmount(); vi.unstubAllGlobals();
  });
  it('auto-registers only new catalog sources and repeated refreshes are write-free', async () => {
    let document = { entries: [
      { virtual_path: 'objects/live.bin', local_path: 'live.bin', size_bytes: 4, sha256: 'kept' },
      { virtual_path: 'objects/missing.bin', local_path: 'missing.bin', size_bytes: 5 },
      { virtual_path: 'ignore/skipped.bin', local_path: 'skipped.bin', size_bytes: 6 },
    ] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => ({ local_files: [
        { local_path: 'live.bin', size_bytes: 4 }, { local_path: 'skipped.bin', size_bytes: 6 }, { local_path: 'candidate.bin', size_bytes: 7 },
      ] })),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(client.putMapping).toHaveBeenCalledTimes(1);
    expect(result.current.mapping?.entries).toEqual([
      { virtual_path: 'objects/live.bin', local_path: 'live.bin', size_bytes: 4, sha256: 'kept' },
      { virtual_path: 'objects/missing.bin', local_path: 'missing.bin', size_bytes: 5 },
      { virtual_path: 'ignore/skipped.bin', local_path: 'skipped.bin', size_bytes: 6 },
      { virtual_path: 'inbox/candidate.bin', local_path: 'candidate.bin', size_bytes: 7 },
    ]);
    await act(() => result.current.refresh());
    expect(client.putMapping).toHaveBeenCalledTimes(1);
  });

  it('drops an absent ignored source and re-registers it in inbox when it returns', async () => {
    let catalog = { local_files: [] as Array<{ local_path: string; size_bytes: number }> };
    let document = { entries: [{ virtual_path: 'ignore/a.bin', local_path: 'a.bin', size_bytes: 3 }] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => catalog),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(client.putMapping).toHaveBeenCalledTimes(1);
    expect(result.current.inventory).toEqual([]);

    catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 3 }, { local_path: 'new.bin', size_bytes: 4 }] };
    await act(() => result.current.refresh());
    expect(document.entries).toEqual([
      { virtual_path: 'inbox/a.bin', local_path: 'a.bin', size_bytes: 3 },
      { virtual_path: 'inbox/new.bin', local_path: 'new.bin', size_bytes: 4 },
    ]);
  });

  it('treats cancelling an already-cleaned absent ignore as idempotent at the UI lifecycle boundary', async () => {
    let catalog = { local_files: [] as Array<{ local_path: string; size_bytes: number }> };
    let document: { entries: Array<{ virtual_path: string; local_path: string; size_bytes?: number }> } = {
      entries: [{ virtual_path: 'ignore/a.bin', local_path: 'a.bin', size_bytes: 3 }],
    };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => catalog),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.unignore(['ignore/a.bin']));
    expect(document.entries).toEqual([]);
    catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 4 }] };
    await act(() => result.current.refresh());
    expect(document.entries).toEqual([{ virtual_path: 'inbox/a.bin', local_path: 'a.bin', size_bytes: 4 }]);
  });

  it('serializes overlapping refreshes so a catalog source is registered once', async () => {
    let document: { entries: { virtual_path: string; local_path: string; size_bytes?: number }[] } = { entries: [] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => ({ local_files: [{ local_path: 'candidate.bin', size_bytes: 7 }] })),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(client.putMapping).mockClear();
    document = { entries: [] };
    await act(() => Promise.all([result.current.refresh(), result.current.refresh()]));
    expect(client.putMapping).toHaveBeenCalledTimes(1);
    expect(document.entries).toEqual([{ virtual_path: 'inbox/candidate.bin', local_path: 'candidate.bin', size_bytes: 7 }]);
  });

  it('serializes registration with a coordinated rename without losing either write', async () => {
    let catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }] };
    let document = { entries: [{ virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 }] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => catalog),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }, { local_path: 'candidate.bin', size_bytes: 2 }] };
    await act(() => Promise.all([
      result.current.refresh(),
      result.current.transition([{ from: 'objects/a.bin', to: '20300102zx0007a0.bin' }]),
    ]));
    expect(document.entries).toEqual([
      { virtual_path: '20300102zx0007a0.bin', local_path: 'a.bin', size_bytes: 1 },
      { virtual_path: 'inbox/candidate.bin', local_path: 'candidate.bin', size_bytes: 2 },
    ]);
  });

  it('confirms discoveries found by ordinary mutation and coordinated transition without another refresh', async () => {
    let catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }] };
    let document = { entries: [{ virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 }] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => catalog),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }, { local_path: 'new-mutate.bin', size_bytes: 2 }] };
    await act(() => result.current.release(['objects/a.bin']));
    expect(document.entries).toEqual([
      { virtual_path: 'inbox/a.bin', local_path: 'a.bin', size_bytes: 1 },
      { virtual_path: 'inbox/new-mutate.bin', local_path: 'new-mutate.bin', size_bytes: 2 },
    ]);
    await act(() => result.current.transition([{ from: 'inbox/a.bin', to: 'objects/a.bin' }]));

    catalog = { local_files: [...catalog.local_files, { local_path: 'new-transition.bin', size_bytes: 3 }] };
    const transition = await act(() => result.current.transition([{ from: 'objects/a.bin', to: '20300102zx0007a0.bin' }]));
    expect(document.entries.find((entry) => entry.local_path === 'new-transition.bin')?.virtual_path).toBe('inbox/new-transition.bin');
    await act(() => result.current.restore(transition.recovery));
    expect(document.entries.find((entry) => entry.local_path === 'new-transition.bin')?.virtual_path).toBe('inbox/new-transition.bin');
    expect(document.entries.find((entry) => entry.local_path === 'a.bin')?.virtual_path).toBe('objects/a.bin');
  });

  it('keeps the last confirmed state visible when automatic registration fails', async () => {
    let catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }] };
    let document = { entries: [{ virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 }] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => catalog),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }, { local_path: 'candidate.bin', size_bytes: 2 }] };
    vi.mocked(client.putMapping).mockRejectedValueOnce(new Error('write unavailable'));
    await expect(result.current.refresh()).rejects.toThrow('write unavailable');
    await act(async () => undefined);
    expect(result.current.mapping).toEqual({ entries: [{ virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 }] });
    await waitFor(() => expect(result.current.error?.message).toBe('write unavailable'));
  });

  it('applies a fingerprint to the latest mapping after a concurrent catalog registration', async () => {
    let catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }] };
    let document: { entries: Array<{ virtual_path: string; local_path: string; size_bytes: number; sha256?: string }> } = {
      entries: [{ virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 }],
    };
    let signalHashStarted!: () => void;
    const hashStarted = new Promise<void>((resolve) => { signalHashStarted = resolve; });
    let finishHash!: (result: HashTerminalResult) => void;
    const hashResult = new Promise<HashTerminalResult>((resolve) => { finishHash = resolve; });
    const client: RfgClient = {
      getCatalog: vi.fn(async () => catalog),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next; return next; }),
      computeHash: vi.fn(async () => { signalHashStarted(); return hashResult; }),
      getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let fingerprintWork!: Promise<unknown>;
    act(() => { fingerprintWork = result.current.fingerprint(['objects/a.bin'], ['sha256']); });
    await hashStarted;
    catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }, { local_path: 'candidate.bin', size_bytes: 2 }] };
    await act(() => result.current.refresh());
    finishHash({ local_path: 'a.bin', algorithm: 'sha256', profile: null, status: 'succeeded', value: 'fresh-hash', code: 'computed', detail: null, error: null });
    await act(() => fingerprintWork);
    expect(document.entries).toEqual([
      { virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1, sha256: 'fresh-hash' },
      { virtual_path: 'inbox/candidate.bin', local_path: 'candidate.bin', size_bytes: 2 },
    ]);
  });

  it('retries a coordinated mapping write at most twice and returns its scoped recovery receipt', async () => {
    const { client, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(client.putMapping).mockRejectedValueOnce(new Error('temporary')).mockRejectedValueOnce(new Error('temporary'));
    let transition!: Awaited<ReturnType<typeof result.current.transition>>;
    await act(async () => { transition = await result.current.transition([{ from: 'objects/a.bin', to: '20300102zx0007a0.bin' }]); });
    expect(client.putMapping).toHaveBeenCalledTimes(3);
    expect(transition.recovery.changes[0]).toMatchObject({
      localPath: 'a.bin', before: { virtual_path: 'objects/a.bin' }, expectedAfter: { virtual_path: '20300102zx0007a0.bin' }, operation: 'rename',
    });
    expect(transition.attempts).toBe(3);
    expect(result.current.mapping?.entries[0].virtual_path).toBe('20300102zx0007a0.bin');
  });

  it('does not repeat a successful PUT when every confirmation read fails and restores the snapshot once', async () => {
    let document = { entries: [{ virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 }] };
    let wrote = false;
    const client: RfgClient = {
      getCatalog: vi.fn(async () => ({ local_files: [{ local_path: 'a.bin', size_bytes: 1 }] })),
      getMapping: vi.fn(async () => {
        if (wrote) throw new Error('read unavailable');
        return { document, etag: null };
      }),
      putMapping: vi.fn(async (next) => { document = next as typeof document; wrote = true; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(act(() => result.current.transition([{ from: 'objects/a.bin', to: '20300102zx0007a0.bin' }]))).rejects.toMatchObject({ attempts: 1, compensationState: 'failed' });
    // Recovery first needs a fresh public mapping read, so unavailable reads
    // cannot trigger an unverified compensation write.
    expect(client.putMapping).toHaveBeenCalledTimes(1);
  });

  it('recognizes a lost successful PUT response without repeating the write', async () => {
    let document = { entries: [{ virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 }] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => ({ local_files: [{ local_path: 'a.bin', size_bytes: 1 }] })),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next as typeof document; throw new Error('response lost'); }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.transition([{ from: 'objects/a.bin', to: '20300102zx0007a0.bin' }]));
    expect(client.putMapping).toHaveBeenCalledTimes(1);
    expect(result.current.mapping?.entries[0].virtual_path).toBe('20300102zx0007a0.bin');
  });

  it('retains an unconfirmed scoped recovery and repairs it without overwriting unrelated entries', async () => {
    const { client, result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const transition = await act(() => result.current.transition([{ from: 'objects/a.bin', to: '20300102zx0007a0.bin' }]));
    const recovery = transition.recovery;
    vi.mocked(client.getMapping).mockRejectedValue(new Error('read unavailable'));
    let restoreWork!: Promise<void>;
    act(() => { restoreWork = result.current.restore(recovery); });
    await expect(restoreWork).rejects.toBeInstanceOf(ResourceMappingMutationError);
    const writesBeforeGuard = vi.mocked(client.putMapping).mock.calls.length;
    await expect(act(() => result.current.release(['20300102zx0007a0.bin']))).rejects.toThrow(/compensation could not be confirmed/);
    expect(client.putMapping).toHaveBeenCalledTimes(writesBeforeGuard);

    const unrelated = { entries: [
      { virtual_path: '20300102zx0007a0.bin', local_path: 'a.bin', size_bytes: 1 },
      { virtual_path: 'inbox/new.bin', local_path: 'new.bin', size_bytes: 2, sha256: 'new-hash' },
    ] };
    const restored = { entries: [
      { virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 },
      { virtual_path: 'inbox/new.bin', local_path: 'new.bin', size_bytes: 2, sha256: 'new-hash' },
    ] };
    vi.mocked(client.getMapping)
      .mockResolvedValueOnce({ document: unrelated, etag: null })
      .mockResolvedValue({ document: restored, etag: null });
    vi.mocked(client.getCatalog).mockResolvedValue({ local_files: [{ local_path: 'a.bin', size_bytes: 1 }, { local_path: 'new.bin', size_bytes: 2 }] });
    await act(() => result.current.refresh());
    expect(result.current.mapping).toEqual(restored);
    // Initial transition and explicit scoped recovery write once each; failed
    // reads and the failed ordinary mutation never write.
    expect(client.putMapping).toHaveBeenCalledTimes(2);
  });

  it('blocks scoped recovery when the affected source was rebound and preserves unrelated entries', async () => {
    let document = { entries: [
      { virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 },
      { virtual_path: 'objects/unrelated.bin', local_path: 'unrelated.bin', size_bytes: 2, sha256: 'old' },
    ] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => ({ local_files: [
        { local_path: 'a.bin', size_bytes: 1 }, { local_path: 'unrelated.bin', size_bytes: 2 },
      ] })),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = structuredClone(next) as typeof document; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const transition = await act(() => result.current.transition([{ from: 'objects/a.bin', to: '20300102zx0007a0.bin' }]));
    document = { entries: [
      { virtual_path: 'objects/rebound.bin', local_path: 'a.bin', size_bytes: 1 },
      { virtual_path: 'objects/unrelated.bin', local_path: 'unrelated.bin', size_bytes: 2, sha256: 'new' },
    ] };
    const writes = vi.mocked(client.putMapping).mock.calls.length;
    await expect(result.current.restore(transition.recovery)).rejects.toThrow(/conflicts/);
    await act(async () => undefined);
    await expect(result.current.release(['objects/rebound.bin'])).rejects.toThrow(/conflicts/);
    await act(async () => undefined);
    expect(client.putMapping).toHaveBeenCalledTimes(writes);
    expect(document.entries).toEqual([
      { virtual_path: 'objects/rebound.bin', local_path: 'a.bin', size_bytes: 1 },
      { virtual_path: 'objects/unrelated.bin', local_path: 'unrelated.bin', size_bytes: 2, sha256: 'new' },
    ]);
  });

  it('blocks auto-registration during recovery and registers on the next refresh after repair', async () => {
    let catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }] };
    let document = { entries: [{ virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 }] };
    let readsFail = false;
    const client: RfgClient = {
      getCatalog: vi.fn(async () => catalog),
      getMapping: vi.fn(async () => {
        if (readsFail) throw new Error('read unavailable');
        return { document, etag: null };
      }),
      putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const transition = await act(() => result.current.transition([{ from: 'objects/a.bin', to: '20300102zx0007a0.bin' }]));
    readsFail = true;
    await expect(result.current.restore(transition.recovery)).rejects.toBeInstanceOf(ResourceMappingMutationError);
    await act(async () => undefined);
    catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }, { local_path: 'candidate.bin', size_bytes: 2 }] };
    readsFail = false;
    const writesBeforeRefresh = vi.mocked(client.putMapping).mock.calls.length;
    await act(() => result.current.refresh());
    expect(client.putMapping).toHaveBeenCalledTimes(writesBeforeRefresh + 2);
    expect(document.entries).toEqual([
      { virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 },
      { virtual_path: 'inbox/candidate.bin', local_path: 'candidate.bin', size_bytes: 2 },
    ]);
  });

  it.each([
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
      expected: [
        { virtual_path: 'objects/a.png', local_path: 'new.png', size_bytes: 3 },
        { virtual_path: 'inbox/old.png', local_path: 'old.png', size_bytes: 2 },
      ],
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

  it('rejects a normal mutation when its resolved PUT is not confirmed by GET', async () => {
    const original = { entries: [{ virtual_path: 'inbox/a.png', local_path: 'a.png', size_bytes: 3 }] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => ({ local_files: [{ local_path: 'a.png', size_bytes: 3 }] })),
      getMapping: vi.fn(async () => ({ document: original, etag: null })),
      putMapping: vi.fn(async (next) => next),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.ignore(['inbox/a.png'])).rejects.toThrow(/changed unexpectedly/);
    await act(async () => undefined);
    expect(result.current.mapping).toEqual(original);
    await waitFor(() => expect(result.current.error?.message).toMatch(/changed unexpectedly/));
  });

  it('confirms a discovery found by auto-rematch even when no candidate is applied', async () => {
    let catalog = { local_files: [{ local_path: 'candidate.bin', size_bytes: 2 }] };
    let document = { entries: [
      { virtual_path: 'objects/target.bin', local_path: 'missing.bin', size_bytes: 1 },
      { virtual_path: 'inbox/candidate.bin', local_path: 'candidate.bin', size_bytes: 2 },
    ] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => catalog),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(client.putMapping).mockClear();
    catalog = { local_files: [...catalog.local_files, { local_path: 'new.bin', size_bytes: 3 }] };
    const outcome = await act(() => result.current.autoRematch(['objects/target.bin'], ['inbox/candidate.bin'], ['filename']));
    expect(outcome.applied).toBe(0);
    expect(client.putMapping).toHaveBeenCalledTimes(1);
    expect(document.entries.find((entry) => entry.local_path === 'new.bin')?.virtual_path).toBe('inbox/new.bin');
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

  it('does not report fingerprint success when the final mapping write is not confirmed', async () => {
    const { client, result } = setup();
    vi.mocked(client.putMapping).mockImplementation(async (next) => next);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.fingerprint(['objects/a.bin'], ['sha256'])).rejects.toThrow(/changed unexpectedly/);
    await act(async () => undefined);
    await waitFor(() => expect(result.current.fingerprintProgress.status).toBe('failed'));
    expect(result.current.mapping?.entries[0]).not.toHaveProperty('sha256');
  });

  it('registers a discovery with the confirmed fingerprint write but publishes none when cancelled', async () => {
    let catalog = { local_files: [{ local_path: 'a.bin', size_bytes: 1 }] };
    let document: { entries: Array<{ virtual_path: string; local_path: string; size_bytes: number; sha256?: string }> } = {
      entries: [{ virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1 }],
    };
    let pendingHash: ((value: HashTerminalResult) => void) | null = null;
    const client: RfgClient = {
      getCatalog: vi.fn(async () => catalog),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next; return next; }),
      computeHash: vi.fn(({ local_path, algorithm }, signal) => new Promise<HashTerminalResult>((resolve, reject) => {
        pendingHash = resolve;
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        void local_path; void algorithm;
      })),
      getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    catalog = { local_files: [...catalog.local_files, { local_path: 'new.bin', size_bytes: 2 }] };
    let work!: Promise<unknown>;
    act(() => { work = result.current.fingerprint(['objects/a.bin'], ['sha256']); });
    await waitFor(() => expect(pendingHash).not.toBeNull());
    pendingHash!({ local_path: 'a.bin', algorithm: 'sha256', profile: null, status: 'succeeded', value: 'hash', code: 'computed', detail: null, error: null });
    await act(() => work);
    expect(document.entries).toEqual([
      { virtual_path: 'objects/a.bin', local_path: 'a.bin', size_bytes: 1, sha256: 'hash' },
      { virtual_path: 'inbox/new.bin', local_path: 'new.bin', size_bytes: 2 },
    ]);

    catalog = { local_files: [...catalog.local_files, { local_path: 'cancelled-new.bin', size_bytes: 3 }] };
    pendingHash = null;
    act(() => { work = result.current.fingerprint(['objects/a.bin'], ['sha256']); });
    await waitFor(() => expect(pendingHash).not.toBeNull());
    act(() => result.current.cancelFingerprint());
    await act(() => work);
    expect(document.entries.some((entry) => entry.local_path === 'cancelled-new.bin')).toBe(false);
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

  it('rejects fingerprinting a stable mapping whose source is absent', async () => {
    let document = { entries: [{ virtual_path: 'objects/missing.bin', local_path: 'missing.bin', size_bytes: 1 }] };
    const client: RfgClient = {
      getCatalog: vi.fn(async () => ({ local_files: [] })),
      getMapping: vi.fn(async () => ({ document, etag: null })),
      putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
      computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
    const { result } = renderHook(() => useResourceMapping(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(act(() => result.current.fingerprint(['objects/missing.bin'], ['sha256']))).rejects.toThrow('fingerprint targets');
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
