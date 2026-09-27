// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization of the two API additions consumed by the UI:
 *
 * - `boardingPassPreviewUrl` builds the prepared paper boarding-pass preview
 *   route (GET /api/flights/{flightId}/boarding-passes/{slot}/preview),
 *   encoding both path parameters.
 * - `api.deleteCatalogEntries` issues the catalog deletion command as a JSON
 *   POST with `{ keys, force }`, parses `{ deleted }`, and surfaces the
 *   project-standard 409 as an ApiError for the forced-delete flow.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, boardingPassPreviewUrl } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('boardingPassPreviewUrl', () => {
  it('builds the preview route for each valid paper slot', () => {
    expect(boardingPassPreviewUrl('f-1', 'paperBoardingPassFront')).toBe('/api/flights/f-1/boarding-passes/paperBoardingPassFront/preview');
    expect(boardingPassPreviewUrl('f-1', 'paperBoardingPassBack')).toBe('/api/flights/f-1/boarding-passes/paperBoardingPassBack/preview');
  });

  it('percent-encodes the flight id and slot path parameters', () => {
    expect(boardingPassPreviewUrl('flight/2026 #1', 'paperBoardingPassFront')).toBe(
      '/api/flights/flight%2F2026%20%231/boarding-passes/paperBoardingPassFront/preview',
    );
  });
});

describe('api.deleteCatalogEntries', () => {
  function stubFetch(response: { ok: boolean; status?: number; body: unknown }) {
    const fetchMock = vi.fn(async () => ({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body,
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sends a JSON POST with the keys and force flag to the catalog delete command', async () => {
    const fetchMock = stubFetch({ ok: true, body: { deleted: ['CA', 'MU'] } });

    const result = await api.deleteCatalogEntries('airlines', ['CA', 'MU']);

    expect(result).toEqual({ deleted: ['CA', 'MU'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/catalogs/airlines/delete');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ keys: ['CA', 'MU'], force: false });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('passes force=true in the body when requested', async () => {
    const fetchMock = stubFetch({ ok: true, body: { deleted: ['CA'] } });

    await api.deleteCatalogEntries('airlines', ['CA'], true);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ keys: ['CA'], force: true });
  });

  it('surfaces the standard 409 conflict as an ApiError for the forced-delete flow', async () => {
    stubFetch({
      ok: false,
      status: 409,
      body: { error: { code: 'conflict', message: 'entries are referenced' } },
    });

    const failure = await api.deleteCatalogEntries('airlines', ['CA']).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).httpStatus).toBe(409);
  });
});

describe('converged status and catalog client', () => {
  it('uses /api/status and does not expect product version fields', async () => {
    const body = { status: { persistence: {}, counts: {} } };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => body }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.status()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/status', { signal: undefined });
  });

  it('uses keyed PUT for both catalog creation and updates', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ entry: {} }) }));
    vi.stubGlobal('fetch', fetchMock);

    await api.putCatalogEntry('airlines', 'Z/Z', { nameEn: 'Zulu' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/catalogs/airlines/Z%2FZ');
    expect(init.method).toBe('PUT');
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

describe('converged resource mutation client', () => {
  function stubMutation(body: unknown) {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sends the explicit rematch discriminant and preserves the compact response', async () => {
    const compact = { applied: 1, ambiguous: [], unmatched: [], revision: '"v2"' };
    const fetchMock = stubMutation(compact);
    const payload = {
      ifMatch: '"v1"',
      mode: 'explicit' as const,
      matches: [{ targetVirtualPath: 'objects/lost.png', candidateInboxVirtualPath: 'inbox/new.png' }],
    };

    await expect(api.rematchResources(payload)).resolves.toEqual(compact);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/resources/rematch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(payload);
    expect(compact).not.toHaveProperty('mapping');
    expect(compact).not.toHaveProperty('localFiles');
  });

  it('sends one reviewed batch array to the sole ignore endpoint', async () => {
    const compact = { ignored: ['ignore/a.png', 'ignore/b.png'], count: 2, revision: '"v2"' };
    const fetchMock = stubMutation(compact);

    await expect(api.ignoreResource({ ifMatch: '"v1"', virtualPaths: ['inbox/a.png', 'inbox/b.png'] })).resolves.toEqual(compact);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/resources/ignore');
    expect(JSON.parse(String(init.body))).toEqual({ ifMatch: '"v1"', virtualPaths: ['inbox/a.png', 'inbox/b.png'] });
  });
});
