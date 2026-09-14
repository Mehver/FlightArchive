// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LanguageProvider } from '../i18n';
import { AppStateProvider } from '../state/AppState';
import { ResourceMappingsPage } from './ResourceMappingsPage';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const PATH = 'objects/unbound.png';

function mockBackend(referenced = false) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, ..._requestArgs: [RequestInit?]) => {
    const url = String(input);
    if (url.includes('/api/resources/sync')) return { ok: true, json: async () => ({ cataloged: 1, added: 0 }) } as unknown as Response;
    if (url.includes('/api/v1/meta/map')) {
      return { ok: true, json: async () => ({ entries: [{ virtual_path: PATH, local_path: '/local/unbound.png' }] }), headers: { get: () => '"v1"' } } as unknown as Response;
    }
    if (url.includes('/api/resources/catalog')) return { ok: true, json: async () => ({ localFiles: [{ local_path: '/local/unbound.png', size_bytes: 12 }] }) } as unknown as Response;
    if (url.includes('/api/resources/release')) return { ok: true, json: async () => ({ released: [PATH], mapping: { entries: [] }, localFiles: [], etag: '"v2"' }) } as unknown as Response;
    if (url.includes('/api/flights')) return { ok: true, json: async () => ({ flights: referenced ? [{ id: 'f1', airlineCode: 'CA', flightNumber: '1', departureDate: '2026-01-01', attachmentResourcePaths: [], paperBoardingPassFrontResourcePath: PATH, paperBoardingPassBackResourcePath: null, electronicBoardingPassResourcePath: null }] : [] }) } as unknown as Response;
    if (url.includes('/api/catalogs')) return { ok: true, json: async () => ({ airlines: [], airports: [], aircraftTypes: [] }) } as unknown as Response;
    if (url.includes('/api/workspace/status')) return { ok: true, json: async () => ({ status: {}, app: 'test', version: 'test' }) } as unknown as Response;
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  render(<LanguageProvider><AppStateProvider><ResourceMappingsPage /></AppStateProvider></LanguageProvider>);
}

describe('ResourceMappingsPage release', () => {
  it('warns about unbound mappings without implying they are locked, and prompts only once', async () => {
    mockBackend();
    renderPage();
    const status = await screen.findByText('Mapped · unbound');
    expect(status.parentElement?.className).toContain('MuiChip-colorWarning');
    expect(screen.queryByTestId('LockOutlinedIcon')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /refresh resources/i }));
    await waitFor(() => expect(screen.getByText('Mapped · unbound')).toBeTruthy());
    expect(screen.queryByRole('dialog', { name: /return resources to pending\?/i })).toBeNull();
  });

  it('only releases after confirmation, sends the reviewed ETag and reloads', async () => {
    const fetchMock = mockBackend();
    renderPage();
    await screen.findByRole('dialog', { name: /return resources to pending\?/i });
    fireEvent.click(screen.getByRole('button', { name: 'Return to Pending' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/resources/release'))).toBe(true));
    const releaseCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/resources/release'))!;
    expect(JSON.parse(String(releaseCall[1]?.body))).toEqual({ ifMatch: '"v1"', virtualPaths: [PATH] });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/resources/sync')).length).toBeGreaterThanOrEqual(2));
  });
});

describe('ResourceMappingsPage usage and fingerprint columns', () => {
  it('shows one type-specific usage summary without a redundant total', async () => {
    mockBackend(true);
    renderPage();
    const table = await screen.findByRole('table', { name: /resource mappings/i });
    expect(within(table).getByText('Fingerprints')).toBeTruthy();
    const row = within(table).getAllByRole('row').find((candidate) => candidate.textContent?.includes(PATH));
    expect(row).toBeDefined();
    const cells = within(row!).getAllByRole('cell');
    expect(within(cells[3]).getByText('1 flight · 0 airlines')).toBeTruthy();
    expect(within(cells[3]).queryByText('1 business record(s)')).toBeNull();
    expect(within(cells[4]).queryByText('1 business record(s)')).toBeNull();
  });
});
