// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization of API boundaries consumed by the UI. Business records are
 * intentionally absent: named archive documents are the
 * only business-data network boundary.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('converged status client', () => {
  it('uses /api/status and does not expect product version fields', async () => {
    const body = { status: {
      persistence: { mode: 'named-json-documents', writable: true, persistenceError: null },
      archiveState: 'ready', activityRevision: null,
    } };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => body }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.status()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/status', { signal: undefined });
  });
});

describe('api.listTasks', () => {
  it('returns log-day pages and encodes optional pagination parameters', async () => {
    const body = {
      days: [{ date: '2026-09-24', tasks: [] }],
      nextCursor: '2026-09-24',
      hasMore: true,
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => body }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.listTasks({ before: '2026-09-24', limitDays: 3 })).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks?before=2026-09-24&limitDays=3', undefined);
  });

  it('does not add a query string when no parameters are supplied', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ days: [], nextCursor: null, hasMore: false }) }));
    vi.stubGlobal('fetch', fetchMock);

    await api.listTasks();
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks', undefined);
  });
});

describe('generic archive and activity clients', () => {
  it('accepts an empty 204 response for named-document PUT and DELETE', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204, json: async () => { throw new Error('no body'); } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.putArchiveDocument('flightarchive', 'settings.json', null)).resolves.toBeUndefined();
    await expect(api.deleteArchiveDocument('flightarchive', 'settings.json')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/archive/flightarchive/documents/settings.json');
    expect(init.body).toBe('null');
  });

  it('encodes activity pagination', async () => {
    const body = { days: [], nextCursor: null, hasMore: false, revision: null };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.listActivity({ before: '2026-09-24', limitDays: 2 })).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/activity?before=2026-09-24&limitDays=2', undefined);
  });
});
