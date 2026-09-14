// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Selection, batch-deletion and flight-reference-count contract of the flight reference library:
 * every row has an accessible checkbox, the header checkbox selects exactly
 * the visible (filtered) rows, and the one-click bulk action deletes the
 * selection only after an explicit count confirmation — reusing the
 * standard forced-delete flow on a 409. Selection resets when the catalog
 * kind changes and after a successful mutation; single-row edit/delete is
 * untouched.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Catalogs, FlightRecord } from '../api/types';
import { LanguageProvider } from '../i18n';
import { AppStateProvider } from '../state/AppState';
import { ReferenceLibraryPage, stringSuggestions } from './ReferenceLibraryPage';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const CATALOGS: Catalogs = {
  airlines: [
    { code: 'CA', icao: 'CCA', nameZh: '中国国航', nameEn: 'Air China', alliance: 'Star Alliance', horizontalLogoResourcePath: null, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: null, brandColors: { primary: null, contrast: null } },
    { code: 'MU', icao: 'CES', nameZh: '东方航空', nameEn: 'China Eastern', alliance: null, horizontalLogoResourcePath: null, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: null, brandColors: { primary: null, contrast: null } },
    { code: 'CZ', icao: 'CSN', nameZh: '南方航空', nameEn: 'China Southern', alliance: null, horizontalLogoResourcePath: null, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: null, brandColors: { primary: null, contrast: null } },
  ],
  airports: [
    { code: 'PEK', icao: 'ZBAA', nameZh: '北京首都', nameEn: 'Beijing Capital', cityZh: '北京', cityEn: 'Beijing', countryZh: '中国', countryEn: 'China', terminals: ['T3'] },
    { code: 'SHA', icao: 'ZSSS', nameZh: '上海虹桥', nameEn: 'Shanghai Hongqiao', cityZh: '上海', cityEn: 'Shanghai', countryZh: '中国', countryEn: 'China', terminals: [] },
    { code: 'CAN', icao: 'ZGGG', nameZh: '广州白云', nameEn: 'Guangzhou Baiyun', cityZh: '广州', cityEn: 'Guangzhou', countryZh: '中国', countryEn: 'China', terminals: [] },
  ],
  aircraftTypes: [
    { icao: 'A320', iata: '320', manufacturer: 'Airbus', displayName: 'Airbus A320' },
    { icao: 'B738', iata: '738', manufacturer: 'Boeing', displayName: 'Boeing 737-800' },
  ],
};

const STATUS = {
  status: {
    persistence: { mode: 'local', schemaVersion: 1, writable: true, loaded: true, persistenceError: null },
    counts: { flights: 3, airlines: 3, airports: 3, aircraftTypes: 2 },
  },
  app: 'flightarchive',
  version: 'test',
};

const FLIGHTS = [
  { airlineCode: 'CA', departureAirport: 'PEK', arrivalAirport: 'SHA', aircraftTypeIcao: 'A320' },
  // Same departure and arrival airport is one airport reference, not two.
  { airlineCode: 'CA', departureAirport: 'PEK', arrivalAirport: 'PEK', aircraftTypeIcao: 'A320' },
  { airlineCode: 'MU', departureAirport: 'SHA', arrivalAirport: 'PEK', aircraftTypeIcao: null },
];

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

interface BatchCall {
  keys: string[];
  force: boolean;
}

function mockBackend(options: {
  batchResults?: Array<{ status?: number; body: unknown }>;
  catalogs?: Catalogs;
  flights?: FlightRecord[];
  catalogResults?: Catalogs[];
} = {}) {
  const batchCalls: BatchCall[] = [];
  const singleDeletes: string[] = [];
  const updateCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const batchQueue = [...(options.batchResults ?? [])];
  const catalogResults = [...(options.catalogResults ?? [])];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/workspace/status')) return jsonResponse(STATUS);
      if (url === '/api/catalogs') return jsonResponse(catalogResults.shift() ?? options.catalogs ?? CATALOGS);
      if (url === '/api/flights') return jsonResponse({ flights: options.flights ?? (FLIGHTS as FlightRecord[]) });
      if (url.startsWith('/api/catalogs/') && init?.method === 'PUT') {
        updateCalls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return jsonResponse({ entry: {} });
      }
      if (url === '/api/catalogs/airlines' && init?.method === 'DELETE') {
        const payload = JSON.parse(String(init.body)) as BatchCall;
        batchCalls.push(payload);
        const next = batchQueue.shift() ?? { body: { deleted: payload.keys } };
        return jsonResponse(next.body, next.status ?? 200);
      }
      if (url.startsWith('/api/catalogs/airlines/') && init?.method === 'DELETE') {
        singleDeletes.push(decodeURIComponent(url.slice('/api/catalogs/airlines/'.length)));
        return jsonResponse({ deleted: 'CA' });
      }
      return jsonResponse({}, 404);
    }),
  );
  return { batchCalls, singleDeletes, updateCalls };
}

function renderPage() {
  render(
    <LanguageProvider>
      <AppStateProvider>
        <ReferenceLibraryPage />
      </AppStateProvider>
    </LanguageProvider>,
  );
}

const firstRowVisible = async () => {
  fireEvent.click(screen.getByRole('tab', { name: 'Airlines' }));
  return screen.findAllByText('中国国航 · Air China');
};

const openAirlinesTab = async () => {
  fireEvent.click(screen.getByRole('tab', { name: 'Airlines' }));
  return screen.findByRole('table', { name: 'Airlines' });
};

function countForRow(tableName: string, rowText: string): string {
  const table = screen.getByRole('table', { name: tableName });
  const row = within(table).getAllByRole('row').find((candidate) => candidate.textContent?.includes(rowText));
  if (!row) throw new Error(`Could not find ${rowText} row`);
  const cells = within(row).getAllByRole('cell');
  return cells[cells.length - 2].textContent ?? '';
}

describe('ReferenceLibraryPage flight reference counts', () => {
  it('counts airline, airport, and aircraft references per tab', async () => {
    mockBackend();
    renderPage();
    await firstRowVisible();

    await waitFor(() => expect(countForRow('Airlines', 'CA')).toBe('2'));
    expect(countForRow('Airlines', 'CZ')).toBe('0');

    fireEvent.click(screen.getByRole('tab', { name: 'Airports' }));
    await screen.findByText('北京首都 · Beijing Capital');
    // PEK appears twice in a same-airport flight but contributes one count.
    expect(countForRow('Airports', 'PEK')).toBe('3');
    expect(countForRow('Airports', 'CAN')).toBe('0');

    fireEvent.click(screen.getByRole('tab', { name: /aircraft types/i }));
    await screen.findByText('Airbus A320');
    // The null aircraft type on MU's flight does not create a type reference.
    expect(countForRow('Aircraft Types', 'A320')).toBe('2');
    expect(countForRow('Aircraft Types', 'B738')).toBe('0');
  });
});

describe('ReferenceLibraryPage airline logos', () => {
  it('counts the three current logo slots', async () => {
    mockBackend();
    renderPage();
    const table = await openAirlinesTab();
    const row = within(table).getAllByRole('row').find((candidate) => candidate.textContent?.includes('CA'));
    expect(row).toBeDefined();
    expect(within(row!).getByText('0/3')).toBeTruthy();
    expect(within(row!).queryByText('0/6')).toBeNull();
  });
});

describe('ReferenceLibraryPage sorting', () => {
  it('deduplicates and naturally sorts only non-empty current catalog values for suggestions', () => {
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    expect(stringSuggestions(['Maker 10', null, 'Maker 2', 'Maker 10', '  '], collator)).toEqual(['Maker 2', 'Maker 10']);
  });

  it('sorts catalog fields with an accessible, direction-aware table header', async () => {
    mockBackend();
    renderPage();
    const table = await openAirlinesTab();

    const codeHeader = within(table).getByRole('button', { name: 'Sort by Code, ascending' });
    fireEvent.click(codeHeader);
    let codes = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[1].textContent);
    expect(codes).toEqual(['CA', 'CZ', 'MU']);
    expect(within(table).getByRole('columnheader', { name: 'Code' }).getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(within(table).getByRole('button', { name: 'Sort by Code, descending' }));
    codes = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[1].textContent);
    expect(codes).toEqual(['MU', 'CZ', 'CA']);
  });

  it('keeps flights newest-first by default and exposes the active date sort', async () => {
    const flights = [
      { ...FLIGHTS[0], id: 'old', flightNumber: '10', departureDate: '2025-01-01', departureTime: '10:00' },
      { ...FLIGHTS[1], id: 'new', flightNumber: '2', departureDate: '2026-01-01', departureTime: '09:00' },
    ] as FlightRecord[];
    mockBackend({ flights });
    renderPage();
    const table = await screen.findByRole('table', { name: 'Flights' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0].textContent).toContain('CA2');
    expect(within(table).getByRole('columnheader', { name: 'Date' }).getAttribute('aria-sort')).toBe('descending');
  });
});

describe('ReferenceLibraryPage selection', () => {
  it('renders an accessible checkbox per row plus the select-all-visible header checkbox', async () => {
    mockBackend();
    renderPage();
    await firstRowVisible();
    expect(screen.getByRole('checkbox', { name: /select all visible entries/i })).toBeTruthy();
    for (const key of ['CA', 'MU', 'CZ']) {
      expect(screen.getByRole('checkbox', { name: `Select ${key}` })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: /Delete selected/ })).toBeNull();
  });

  it('shows the bulk action with a clear count once rows are selected', async () => {
    mockBackend();
    renderPage();
    await firstRowVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CA' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select MU' }));
    expect(screen.getByRole('button', { name: /delete selected \(2\)/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CA' }));
    expect(screen.getByRole('button', { name: /delete selected \(1\)/i })).toBeTruthy();
  });

  it('selects exactly the visible rows with the header checkbox, honoring the active filter', async () => {
    mockBackend();
    renderPage();
    await firstRowVisible();
    fireEvent.change(screen.getByLabelText(/search flight reference entries/i), { target: { value: 'eastern' } });
    await waitFor(() => expect(screen.queryByText('中国国航 · Air China')).toBeNull());

    fireEvent.click(screen.getByRole('checkbox', { name: /select all visible entries/i }));
    expect(screen.getByRole('button', { name: /delete selected \(1\)/i })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/search flight reference entries/i), { target: { value: '' } });
    await firstRowVisible();
    expect((screen.getByRole('checkbox', { name: 'Select MU' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Select CA' }) as HTMLInputElement).checked).toBe(false);
  });

  it('resets the selection when switching catalog kind', async () => {
    mockBackend();
    renderPage();
    await firstRowVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CA' }));
    expect(screen.getByRole('button', { name: /delete selected \(1\)/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Airports' }));
    await screen.findByText('北京首都 · Beijing Capital');
    expect(screen.queryByRole('button', { name: /Delete selected/ })).toBeNull();
  });
});

describe('ReferenceLibraryPage batch deletion', () => {
  it('deletes the selection only after explicit confirmation, then clears it', async () => {
    const { batchCalls } = mockBackend();
    renderPage();
    await firstRowVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CA' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select MU' }));
    fireEvent.click(screen.getByRole('button', { name: /delete selected \(2\)/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete 2 selected entries?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(batchCalls).toEqual([{ keys: ['CA', 'MU'], force: false }]));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Delete selected/ })).toBeNull());
  });

  it('does not call the backend when the confirmation is cancelled', async () => {
    const { batchCalls } = mockBackend();
    renderPage();
    await firstRowVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CA' }));
    fireEvent.click(screen.getByRole('button', { name: /delete selected \(1\)/i }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(batchCalls).toEqual([]);
    expect(screen.getByRole('button', { name: /delete selected \(1\)/i })).toBeTruthy();
  });

  it('reuses the forced-delete confirmation on a 409 and retries with force', async () => {
    const { batchCalls } = mockBackend({
      batchResults: [{ status: 409, body: { error: { code: 'conflict', message: 'entries are referenced' } } }],
    });
    renderPage();
    await firstRowVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CZ' }));
    fireEvent.click(screen.getByRole('button', { name: /delete selected \(1\)/i }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await screen.findAllByText(/selected entries are referenced/i);
    fireEvent.click(screen.getByRole('button', { name: /delete anyway/i }));

    await waitFor(() =>
      expect(batchCalls).toEqual([
        { keys: ['CZ'], force: false },
        { keys: ['CZ'], force: true },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: /Delete selected/ })).toBeNull());
  });
});

describe('ReferenceLibraryPage single-row behavior', () => {
  it('keeps the single-row delete flow intact alongside selection', async () => {
    const { singleDeletes, batchCalls } = mockBackend();
    renderPage();
    await firstRowVisible();
    fireEvent.click(screen.getAllByRole('button', { name: /delete catalog entry/i })[0]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete CA?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(singleDeletes).toEqual(['CA']));
    expect(batchCalls).toEqual([]);
  });
});

describe('ReferenceLibraryPage unlisted flight references', () => {
  const UNLISTED_FLIGHTS = [
    { ...FLIGHTS[0], airlineCode: 'ZZ', departureAirport: 'XYZ', arrivalAirport: 'QWE', aircraftTypeIcao: 'ZZZZ' },
    { ...FLIGHTS[1], airlineCode: 'AA', departureAirport: 'XYZ', arrivalAirport: 'QWE', aircraftTypeIcao: 'ZZZZ' },
    // A three-character ICAO aircraft type designator is valid and is derived
    // just like the four-character entry above.
    { ...FLIGHTS[2], airlineCode: 'Z', departureAirport: '12', arrivalAirport: 'QWE', aircraftTypeIcao: 'ABC' },
  ] as FlightRecord[];

  it('derives, deduplicates, and orders unlisted references for every catalog kind', async () => {
    mockBackend({ flights: UNLISTED_FLIGHTS });
    renderPage();
    await openAirlinesTab();
    await screen.findAllByText('未收录 · Unlisted');

    let table = screen.getByRole('table', { name: 'Airlines' });
    let codes = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[1].textContent);
    expect(codes.slice(0, 2)).toEqual(['AA', 'ZZ']);
    expect(screen.queryByRole('checkbox', { name: 'Select AA' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Select ZZ' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Airports' }));
    await screen.findByText('北京首都 · Beijing Capital');
    table = screen.getByRole('table', { name: 'Airports' });
    codes = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[1].textContent);
    expect(codes.slice(0, 2)).toEqual(['QWE', 'XYZ']);
    expect(screen.queryByRole('checkbox', { name: 'Select QWE' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /aircraft types/i }));
    await screen.findByText('ZZZZ');
    table = screen.getByRole('table', { name: 'Aircraft Types' });
    codes = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[1].textContent);
    expect(codes.slice(0, 2)).toEqual(['ABC', 'ZZZZ']);
    expect(screen.queryByRole('checkbox', { name: 'Select ABC' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Select ZZZZ' })).toBeNull();
  });

  it('excludes derived rows from select-all and deletion while retaining persisted rows', async () => {
    const { batchCalls, singleDeletes } = mockBackend({ flights: UNLISTED_FLIGHTS });
    renderPage();
    await openAirlinesTab();
    await screen.findAllByText('未收录 · Unlisted');

    fireEvent.click(screen.getByRole('checkbox', { name: /select all visible entries/i }));
    expect(screen.getByRole('button', { name: /delete selected \(3\)/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /delete catalog entry/i })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: /delete selected \(3\)/i }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(batchCalls).toEqual([{ keys: ['CA', 'MU', 'CZ'], force: false }]));
    expect(singleDeletes).toEqual([]);
  });

  it('filters derived rows and renders them when the persisted catalog is empty', async () => {
    mockBackend({ catalogs: { ...CATALOGS, airlines: [] }, flights: UNLISTED_FLIGHTS });
    renderPage();
    await openAirlinesTab();
    await screen.findAllByText('未收录 · Unlisted');
    expect(screen.getByRole('table', { name: 'Airlines' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/search flight reference entries/i), { target: { value: 'zz' } });
    await waitFor(() => expect(screen.queryByText('AA')).toBeNull());
    expect(screen.getByText('ZZ')).toBeTruthy();
  });

  it('edits an unlisted row through PUT, reports it as added, and treats it as normal after refresh', async () => {
    const refreshed: Catalogs = {
      ...CATALOGS,
      airlines: [{ code: 'ZZ', icao: '', nameZh: '', nameEn: 'Zulu Air', alliance: null, horizontalLogoResourcePath: null, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: null, brandColors: { primary: null, contrast: null } }, ...CATALOGS.airlines],
    };
    const { updateCalls } = mockBackend({ flights: UNLISTED_FLIGHTS, catalogResults: [CATALOGS, refreshed] });
    renderPage();
    await openAirlinesTab();
    await screen.findAllByText('未收录 · Unlisted');

    const table = screen.getByRole('table', { name: 'Airlines' });
    const unlistedRow = within(table).getAllByRole('row').find((row) => row.textContent?.includes('ZZ'));
    if (!unlistedRow) throw new Error('Could not find ZZ row');
    fireEvent.click(within(unlistedRow).getByRole('button', { name: 'Edit Airlines' }));
    const dialog = await screen.findByRole('dialog');
    const inputs = within(dialog).getAllByRole('textbox') as HTMLInputElement[];
    expect(inputs[0].disabled).toBe(true);
    fireEvent.change(inputs[3], { target: { value: 'Zulu Air' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateCalls).toEqual([{ url: '/api/catalogs/airlines/ZZ', body: expect.objectContaining({ code: 'ZZ', nameEn: 'Zulu Air' }) }]));
    await screen.findByText('Catalog entry added.');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getAllByText('未收录 · Unlisted')).toHaveLength(1));
    expect(screen.getByRole('checkbox', { name: 'Select ZZ' })).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Airlines' })).getAllByRole('button', { name: /delete catalog entry/i })).toHaveLength(4);
  });
});
