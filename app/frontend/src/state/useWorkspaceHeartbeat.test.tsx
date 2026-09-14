// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceStatus } from '../api/types';
import { useWorkspaceHeartbeat } from './useWorkspaceHeartbeat';

const workspaceStatus: WorkspaceStatus = {
  persistence: { mode: 'local', schemaVersion: 1, writable: true, loaded: true, persistenceError: null },
  counts: { flights: 0, airlines: 0, airports: 0, aircraftTypes: 0 },
};

describe('useWorkspaceHeartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('checks immediately and keeps online visible during background polling', async () => {
    vi.useFakeTimers();
    let resolvePoll!: (value: { status: WorkspaceStatus }) => void;
    const check = vi.fn()
      .mockResolvedValueOnce({ status: workspaceStatus })
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    const { result } = renderHook(() => useWorkspaceHeartbeat(check, 30_000));

    await act(async () => undefined);
    expect(result.current.connectivity).toBe('online');
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(result.current.connectivity).toBe('online');
    await act(async () => { resolvePoll({ status: workspaceStatus }); });
    expect(result.current.connectivity).toBe('online');
  });

  it('marks a manual check as checking and ignores an aborted older result', async () => {
    vi.useFakeTimers();
    let resolveOlder!: (value: { status: WorkspaceStatus }) => void;
    let resolveNewer!: (value: { status: WorkspaceStatus }) => void;
    const check = vi.fn()
      .mockResolvedValueOnce({ status: workspaceStatus })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewer = resolve; }));
    const { result } = renderHook(() => useWorkspaceHeartbeat(check, 30_000));

    await act(async () => undefined);
    act(() => { void result.current.recheck(); });
    expect(result.current.connectivity).toBe('checking');
    act(() => { void result.current.recheck(); });
    await act(async () => { resolveOlder({ status: { ...workspaceStatus, counts: { ...workspaceStatus.counts, flights: 1 } } }); });
    expect(result.current.connectivity).toBe('checking');
    await act(async () => { resolveNewer({ status: workspaceStatus }); });
    expect(result.current).toMatchObject({ connectivity: 'online', status: workspaceStatus });
  });
});
