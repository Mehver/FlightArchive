// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization of the two API additions consumed by the UI:
 *
 * - `boardingPassPreviewUrl` builds the prepared paper boarding-pass preview
 *   route (GET /api/flights/{flightId}/boarding-passes/{slot}/preview),
 *   encoding both path parameters.
 * - `api.deleteCatalogEntries` issues the batch catalog deletion as a JSON
 *   DELETE with `{ keys, force }`, parses `{ deleted }`, and surfaces the
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

  it('sends a JSON DELETE with the keys and force flag to the catalog kind route', async () => {
    const fetchMock = stubFetch({ ok: true, body: { deleted: ['CA', 'MU'] } });

    const result = await api.deleteCatalogEntries('airlines', ['CA', 'MU']);

    expect(result).toEqual({ deleted: ['CA', 'MU'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/catalogs/airlines');
    expect(init.method).toBe('DELETE');
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
