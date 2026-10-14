// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Airline, FlightRecord } from '../domain/types';
import type { MappingDocument, RfgClient } from '../rfg/api';
import { ResourceMappingProvider, useResourceMapping, type ResourceMappingContextValue } from '../rfg/ResourceMappingProvider';
import { LanguageProvider } from '../i18n';
import { AppStateProvider } from '../state/AppState';
import { BUSINESS_DATA_MANIFEST } from '../domain/archiveV2';
import { ReferenceLibraryPage } from './ReferenceLibraryPage';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const AIRLINE: Airline = { code: 'CA', icao: 'CCA', nameZh: '', nameEn: 'Air China', alliance: null, horizontalLogoResourcePath: null, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: null, brandColors: { primary: null, contrast: null } };
const AIRPORTS = [
  { code: 'PEK', icao: 'ZBAA', nameZh: '', nameEn: 'Beijing', cityZh: '', cityEn: 'Beijing', countryZh: '', countryEn: 'China', terminals: [] },
  { code: 'SHA', icao: 'ZSSS', nameZh: '', nameEn: 'Shanghai', cityZh: '', cityEn: 'Shanghai', countryZh: '', countryEn: 'China', terminals: [] },
];
const layout = { schemaVersion: 1 as const, algorithm: 'adaptive' as const, crop: { centerX: 50, centerY: 40, width: 30, height: 20, rotationDegrees: 3 }, templateId: 'bp-247.svg', placement: { scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0 } };
let capturedResources: ResourceMappingContextValue | null = null;
function CaptureResources() { capturedResources = useResourceMapping(); return null; }

function flight(id: string, path: string | null, date = '2026-01-01'): FlightRecord {
  return {
    id, flightNumber: id === 'primary' ? '10' : '20', airlineCode: 'CA', departureAirport: 'PEK', arrivalAirport: 'SHA', departureTerminal: null, arrivalTerminal: null,
    departureDate: date, departureTime: null, arrivalTime: null, aircraftTypeIcao: null, registration: null, seat: null, notes: '', createdAt: `${date}T00:00:00Z`, updatedAt: `${date}T00:00:00Z`,
    paperBoardingPassFrontResourcePath: path, paperBoardingPassBackResourcePath: null, electronicBoardingPassResourcePath: null, attachmentResourcePaths: [],
    paperBoardingPassLayouts: path ? { paperBoardingPassFront: layout } : {}, electronicBoardingPass: null, boardingPassColor: null,
  };
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() } as Response;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(options: {
  flights?: FlightRecord[];
  airlines?: Airline[];
  entries?: MappingDocument['entries'];
  localFiles?: Array<{ local_path: string; size_bytes: number }>;
  failMapping?: (next: MappingDocument, attempt: number) => boolean;
  failMappingReadsAfterPut?: boolean;
  failArchive?: (id: string, attempt: number) => boolean;
  beforeArchiveWrite?: (id: string) => Promise<void>;
} = {}) {
  let mapping: MappingDocument = { entries: (options.entries ?? []).map((entry) => ({ ...entry })) };
  let localFiles = options.localFiles ?? mapping.entries.map((entry) => ({ local_path: entry.local_path, size_bytes: entry.size_bytes ?? 1 }));
  const order: string[] = []; const mappingPuts: MappingDocument[] = []; const archivePuts: Array<{ id: string; body: unknown }> = []; const activities: unknown[] = [];
  let mappingAttempt = 0, archiveAttempt = 0;
  let mappingWriteApplied = false;
  const documents: Record<string, unknown> = {
    'manifest.json': BUSINESS_DATA_MANIFEST,
    'flights.json': structuredClone(options.flights ?? []),
    'airlines.json': structuredClone(options.airlines ?? [AIRLINE]),
    'airports.json': AIRPORTS,
    'aircraft-types.json': [],
    'settings.json': {},
  };
  const client: RfgClient = {
    getCatalog: vi.fn(async () => ({ local_files: structuredClone(localFiles) })),
    getMapping: vi.fn(async () => {
      if (options.failMappingReadsAfterPut && mappingWriteApplied) throw new Error('mapping read unavailable');
      return { document: structuredClone(mapping), etag: null };
    }),
    putMapping: vi.fn(async (next) => {
      mappingAttempt++; order.push('resource-put'); mappingPuts.push(structuredClone(next));
      if (options.failMapping?.(next, mappingAttempt)) throw new Error('mapping write failed');
      mapping = structuredClone(next); mappingWriteApplied = true; return next;
    }),
    computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/status')) return response({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } });
    if (url === '/api/activity' && init?.method === 'POST') { activities.push(JSON.parse(String(init.body))); return response({}); }
    const prefix = '/api/archive/flightarchive/documents/';
    if (url.startsWith(prefix)) {
      const id = decodeURIComponent(url.slice(prefix.length));
      if (init?.method === 'PUT') {
        archiveAttempt++; const body = JSON.parse(String(init.body)); order.push(`archive-put:${id}`); archivePuts.push({ id, body });
        await options.beforeArchiveWrite?.(id);
        if (options.failArchive?.(id, archiveAttempt)) return response({ error: { code: 'write-failed' } }, 500);
        documents[id] = structuredClone(body); return response(undefined, 204);
      }
      return response(structuredClone(documents[id]));
    }
    return response({}, 404);
  }));
  capturedResources = null;
  render(<LanguageProvider><ResourceMappingProvider client={client}><CaptureResources /><AppStateProvider><ReferenceLibraryPage /></AppStateProvider></ResourceMappingProvider></LanguageProvider>);
  return {
    client, documents, order, mappingPuts, archivePuts, activities, mapping: () => mapping,
    resources: () => capturedResources!,
    setLocalFiles: (next: typeof localFiles) => { localFiles = structuredClone(next); },
    setServerMapping: (next: MappingDocument) => { mapping = structuredClone(next); },
  };
}

async function openDeleteFlight(id: string) {
  const checkbox = await screen.findByRole('checkbox', { name: `Select ${id}` });
  const row = checkbox.closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: 'Delete Flight' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
}

async function chooseResource(dialog: HTMLElement, label: string, path: string) {
  const row = within(dialog).getByText(label, { exact: true }).parentElement!;
  fireEvent.click(within(row).getByRole('button', { name: /Select Resource|Change Resource/ }));
  const picker = await screen.findByRole('dialog', { name: label });
  fireEvent.click(within(picker).getByRole('button', { name: new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
  fireEvent.click(within(picker).getByRole('button', { name: 'Select Resource' }));
}

describe('ReferenceLibraryPage resource coordination integration', () => {
  it('creates a first referenced flight with the generated id in both managed path and persisted record', async () => {
    const source = 'inbox/new-pass.png';
    const state = setup({ entries: [{ virtual_path: source, local_path: 'new-pass.png', size_bytes: 4, sha256: 'keep' }] });
    await screen.findByText('No Flights Yet');
    fireEvent.click(screen.getByRole('button', { name: 'Add Flight' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Flight' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Airline' }), { target: { value: 'CA' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Flight Number' }), { target: { value: '88' } });
    fireEvent.change(dialog.querySelector('input[type="date"]')!, { target: { value: '2026-03-04' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Origin Airport' }), { target: { value: 'PEK' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Destination Airport' }), { target: { value: 'SHA' } });
    await chooseResource(dialog, 'Paper Front', source);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Flight added.');
    const saved = (state.documents['flights.json'] as FlightRecord[])[0];
    expect(saved.paperBoardingPassFrontResourcePath).toBe('20260304ca0088a0.png');
    expect(state.mapping().entries[0]).toMatchObject({ virtual_path: saved.paperBoardingPassFrontResourcePath, local_path: 'new-pass.png', sha256: 'keep' });
    expect(state.order.indexOf('resource-put')).toBeLessThan(state.order.indexOf('archive-put:flights.json'));
  }, 10_000);

  it('rejects exhausted generated-id collisions before any resource or archive write', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('existing' as `${string}-${string}-${string}-${string}-${string}`);
    const source = 'inbox/collision-pass.png';
    const state = setup({ flights: [flight('existing', null)], entries: [{ virtual_path: source, local_path: 'collision-pass.png', size_bytes: 4 }] });
    await screen.findByRole('checkbox', { name: 'Select existing' });
    fireEvent.click(screen.getByRole('button', { name: 'Add Flight' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Flight' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Airline' }), { target: { value: 'CA' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Flight Number' }), { target: { value: '89' } });
    fireEvent.change(dialog.querySelector('input[type="date"]')!, { target: { value: '2026-03-05' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Origin Airport' }), { target: { value: 'PEK' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Destination Airport' }), { target: { value: 'SHA' } });
    await chooseResource(dialog, 'Paper Front', source);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText(/Could not save flight/i);
    expect(state.mappingPuts).toHaveLength(0);
    expect(state.archivePuts).toHaveLength(0);
    expect((state.documents['flights.json'] as FlightRecord[]).map((item) => item.id)).toEqual(['existing']);
  }, 10_000);

  it('deleting a primary owner retargets all remaining duplicate and cross-owner references while preserving crop metadata', async () => {
    const path = '20260101ca0010a0.png';
    const primary = flight('primary', path);
    const remaining = { ...flight('remaining', path, '2026-02-01'), paperBoardingPassBackResourcePath: path, electronicBoardingPassResourcePath: path, attachmentResourcePaths: [path], electronicBoardingPass: { schemaVersion: 1 as const, extraction: null } };
    const airline = { ...AIRLINE, horizontalLogoResourcePath: path, horizontalDarkLogoResourcePath: path, symbolLogoResourcePath: path };
    const state = setup({ flights: [primary, remaining], airlines: [airline], entries: [{ virtual_path: path, local_path: 'shared.png', size_bytes: 9, sha256: 'hash' }] });
    await openDeleteFlight('primary');
    await waitFor(() => expect((state.documents['flights.json'] as FlightRecord[]).map((item) => item.id)).toEqual(['remaining']));
    const savedFlight = (state.documents['flights.json'] as FlightRecord[])[0];
    const target = savedFlight.paperBoardingPassFrontResourcePath!;
    expect(target).toBe('ca-horizontal.png');
    expect([savedFlight.paperBoardingPassBackResourcePath, savedFlight.electronicBoardingPassResourcePath, ...savedFlight.attachmentResourcePaths]).toEqual([target, target, target]);
    expect(savedFlight.paperBoardingPassLayouts?.paperBoardingPassFront).toEqual(layout);
    const savedAirline = (state.documents['airlines.json'] as Airline[])[0];
    expect([savedAirline.horizontalLogoResourcePath, savedAirline.horizontalDarkLogoResourcePath, savedAirline.symbolLogoResourcePath]).toEqual([target, target, target]);
    expect(state.mapping().entries[0]).toMatchObject({ virtual_path: target, local_path: 'shared.png', sha256: 'hash' });
  });

  it('creates a new airline logo first binding and performs no resource write when its draft is cancelled', async () => {
    const first = 'inbox/airline-logo.png', dark = 'inbox/airline-dark.png', horizontal = 'inbox/airline-horizontal.png', cancelled = 'inbox/cancelled.png';
    const state = setup({ airlines: [], entries: [
      { virtual_path: first, local_path: 'airline-logo.png', size_bytes: 3 },
      { virtual_path: dark, local_path: 'airline-dark.png', size_bytes: 3 },
      { virtual_path: horizontal, local_path: 'airline-horizontal.png', size_bytes: 3 },
      { virtual_path: cancelled, local_path: 'cancelled.png', size_bytes: 4 },
    ] });
    fireEvent.click(await screen.findByRole('tab', { name: 'Airlines' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Airlines' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Airlines' });
    fireEvent.change(within(dialog).getByLabelText(/IATA code/i), { target: { value: 'ZZ' } });
    fireEvent.change(within(dialog).getByLabelText('Name (English)'), { target: { value: 'Zulu Air' } });
    await chooseResource(dialog, 'Horizontal Logo', horizontal);
    await chooseResource(dialog, 'Horizontal Dark Logo', dark);
    await chooseResource(dialog, 'Symbol Logo', first);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Catalog entry added.');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Airlines' })).toBeNull());
    const saved = (state.documents['airlines.json'] as Airline[])[0];
    expect(saved.symbolLogoResourcePath).toBe('zz-symbol.png');
    expect(saved.horizontalLogoResourcePath).toBe('zz-horizontal.png');
    expect(saved.horizontalDarkLogoResourcePath).toBe('zz-horizontal-dark.png');
    expect(state.mapping().entries.find((entry) => entry.local_path === 'airline-logo.png')?.virtual_path).toBe(saved.symbolLogoResourcePath);

    const row = screen.getByText('ZZ').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: /edit airlines/i }));
    const edit = await screen.findByRole('dialog', { name: /Edit Airlines/i });
    await chooseResource(edit, 'Symbol Logo', cancelled);
    const putsBeforeCancel = state.mappingPuts.length;
    fireEvent.click(within(edit).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit Airlines/i })).toBeNull());
    expect(state.mappingPuts).toHaveLength(putsBeforeCancel);
    expect((state.documents['airlines.json'] as Airline[])[0].symbolLogoResourcePath).toBe(saved.symbolLogoResourcePath);
  });

  it('does not create a record when an inbox source disappears before first binding', async () => {
    const source = 'inbox/raced-away.png';
    const state = setup({ entries: [{ virtual_path: source, local_path: 'raced-away.png', size_bytes: 4 }] });
    await screen.findByText('No Flights Yet');
    fireEvent.click(screen.getByRole('button', { name: 'Add Flight' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Flight' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Airline' }), { target: { value: 'CA' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Flight Number' }), { target: { value: '90' } });
    fireEvent.change(dialog.querySelector('input[type="date"]')!, { target: { value: '2026-03-06' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Origin Airport' }), { target: { value: 'PEK' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Destination Airport' }), { target: { value: 'SHA' } });
    await chooseResource(dialog, 'Paper Front', source);
    state.setLocalFiles([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText(/Operation Failed/i);
    expect(state.archivePuts).toHaveLength(0);
    expect(state.documents['flights.json']).toEqual([]);
  });

  it('replacing an actual flight source releases the old source and clears only that slot crop', async () => {
    const oldPath = '20260101ca0020a0.png', replacement = 'inbox/replacement.png';
    const state = setup({ flights: [flight('one', oldPath)], entries: [
      { virtual_path: oldPath, local_path: 'old.png', size_bytes: 2 },
      { virtual_path: replacement, local_path: 'replacement.png', size_bytes: 3 },
    ] });
    const checkbox = await screen.findByRole('checkbox', { name: 'Select one' });
    fireEvent.click(within(checkbox.closest('tr')!).getByRole('button', { name: 'Edit Flight' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Flight' });
    await chooseResource(dialog, 'Paper Front', replacement);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Flight updated.');
    const saved = (state.documents['flights.json'] as FlightRecord[])[0];
    expect(saved.paperBoardingPassFrontResourcePath).toBe('20260101ca0020a2.png');
    expect(saved.paperBoardingPassLayouts?.paperBoardingPassFront).toBeUndefined();
    expect(state.mapping().entries.find((entry) => entry.local_path === 'old.png')?.virtual_path).toBe('inbox/old.png');
  });

  it('renames the controlling resource before saving editable flight naming fields', async () => {
    const oldPath = '20260101ca0020a0.png';
    const zx = { ...AIRLINE, code: 'ZX', icao: 'ZZX', nameEn: 'Zulu Air' };
    const state = setup({ flights: [flight('one', oldPath)], airlines: [AIRLINE, zx], entries: [
      { virtual_path: oldPath, local_path: 'front.png', size_bytes: 2, sha256: 'keep' },
    ] });
    const checkbox = await screen.findByRole('checkbox', { name: 'Select one' });
    fireEvent.click(within(checkbox.closest('tr')!).getByRole('button', { name: 'Edit Flight' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Flight' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Airline' }), { target: { value: 'ZX' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Flight Number' }), { target: { value: '88' } });
    fireEvent.change(dialog.querySelector('input[type="date"]')!, { target: { value: '2031-04-05' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Flight updated.');
    const saved = (state.documents['flights.json'] as FlightRecord[])[0];
    expect(saved.paperBoardingPassFrontResourcePath).toBe('20310405zx0088a0.png');
    expect(saved.paperBoardingPassLayouts?.paperBoardingPassFront).toEqual(layout);
    expect(state.mapping().entries[0]).toMatchObject({ virtual_path: '20310405zx0088a0.png', local_path: 'front.png', sha256: 'keep' });
    expect(state.order.indexOf('resource-put')).toBeLessThan(state.order.indexOf('archive-put:flights.json'));
  });

  it('serial batch deletion commits one success before a three-attempt failure and retains only the failed selection', async () => {
    const a = '20260201ca0020a0.png', b = '20260101ca0020a0.png';
    const state = setup({ flights: [flight('a', a, '2026-02-01'), flight('b', b, '2026-01-01')], entries: [
      { virtual_path: a, local_path: 'a.png', size_bytes: 1 }, { virtual_path: b, local_path: 'b.png', size_bytes: 1 },
    ], failMapping: (next) => next.entries.some((entry) => entry.local_path === 'b.png' && entry.virtual_path === 'inbox/b.png') });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select a' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select b' }));
    fireEvent.click(screen.getByRole('button', { name: /Delete Selected \(2\)/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect((state.documents['flights.json'] as FlightRecord[]).map((item) => item.id)).toEqual(['b']));
    expect(state.mapping().entries.find((entry) => entry.local_path === 'a.png')?.virtual_path).toBe('inbox/a.png');
    expect(state.mappingPuts.filter((document) => document.entries.some((entry) => entry.local_path === 'b.png' && entry.virtual_path === 'inbox/b.png'))).toHaveLength(3);
    expect((screen.getByRole('checkbox', { name: 'Select b', hidden: true }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: 'Select a', hidden: true })).toBeNull();
    expect(state.order.indexOf('resource-put')).toBeLessThan(state.order.indexOf('archive-put:flights.json'));
  });

  it('saves metadata on an unchanged missing legacy reference without attempting resource migration', async () => {
    const path = 'objects/legacy-missing.png';
    const state = setup({ flights: [flight('legacy', path)], entries: [{ virtual_path: path, local_path: 'gone.png', size_bytes: 2 }], localFiles: [] });
    const checkbox = await screen.findByRole('checkbox', { name: 'Select legacy' });
    fireEvent.click(within(checkbox.closest('tr')!).getByRole('button', { name: 'Edit Flight' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Flight' });
    fireEvent.change(within(dialog).getByLabelText('Notes'), { target: { value: 'metadata only' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Flight updated.');
    expect((state.documents['flights.json'] as FlightRecord[])[0].notes).toBe('metadata only');
    expect(state.mappingPuts).toHaveLength(0);
  });

  it('deletes the last flight reference while the source catalog is empty after releasing the virtual mapping', async () => {
    const path = '20260101ca0020a0.png';
    const state = setup({ flights: [flight('only', path)], entries: [{ virtual_path: path, local_path: 'gone.png', size_bytes: 2, sha256: 'remembered' }], localFiles: [] });
    await openDeleteFlight('only');
    await waitFor(() => expect(state.documents['flights.json']).toEqual([]));
    expect(state.mapping().entries).toEqual([]);
    expect(state.order.indexOf('resource-put')).toBeLessThan(state.order.indexOf('archive-put:flights.json'));
  });

  it('renames a shared missing mapping to the remaining owner and preserves its crop and hashes', async () => {
    const path = '20260101ca0010a0.png';
    const primary = flight('primary', path);
    const remaining = flight('remaining', path, '2026-02-01');
    const state = setup({ flights: [primary, remaining], entries: [{ virtual_path: path, local_path: 'gone.png', size_bytes: 9, sha256: 'remembered' }], localFiles: [] });
    await openDeleteFlight('primary');
    await waitFor(() => expect((state.documents['flights.json'] as FlightRecord[]).map((item) => item.id)).toEqual(['remaining']));
    const saved = (state.documents['flights.json'] as FlightRecord[])[0];
    expect(saved.paperBoardingPassFrontResourcePath).toBe('20260201ca0020a0.png');
    expect(saved.paperBoardingPassLayouts?.paperBoardingPassFront).toEqual(layout);
    expect(state.mapping().entries[0]).toMatchObject({ virtual_path: saved.paperBoardingPassFrontResourcePath, local_path: 'gone.png', sha256: 'remembered' });
  });

  it('retries a failed resource PUT three times, performs no archive write, retains the selected record, and reports failure', async () => {
    const path = '20260101ca0020a0.png';
    const state = setup({ flights: [flight('only', path)], entries: [{ virtual_path: path, local_path: 'only.png', size_bytes: 2 }], failMapping: () => true });
    const checkbox = await screen.findByRole('checkbox', { name: 'Select only' }); fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /Delete Selected \(1\)/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(state.mappingPuts).toHaveLength(3));
    expect(state.archivePuts).toHaveLength(0);
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Select only', hidden: true }) as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText(/Operation Failed/i)).toBeTruthy();
    await waitFor(() => expect(state.activities.some((value) => (value as { code?: string }).code === 'resource-coordination-failed')).toBe(true));
    const activity = state.activities.find((value) => (value as { code?: string }).code === 'resource-coordination-failed') as { details: { resourceAttempts: number } };
    expect(activity.details.resourceAttempts).toBe(3);
  });

  it('reports an unconfirmed post-write recovery distinctly and still performs no archive deletion', async () => {
    const path = '20260101ca0020a0.png';
    const state = setup({ flights: [flight('only', path)], entries: [{ virtual_path: path, local_path: 'only.png', size_bytes: 2 }], failMappingReadsAfterPut: true });
    await openDeleteFlight('only');
    await waitFor(() => expect(state.mappingPuts).toHaveLength(1));
    expect(state.archivePuts).toHaveLength(0);
    expect((state.documents['flights.json'] as FlightRecord[])[0].id).toBe('only');
    expect(screen.getByText(/resource recovery could not be confirmed/i)).toBeTruthy();
    await waitFor(() => expect(state.activities.some((value) => (value as { code?: string }).code === 'resource-coordination-compensation-failed')).toBe(true));
  });

  it('restores mapping and the current record when archive persistence fails', async () => {
    const path = '20260101ca0020a0.png';
    const state = setup({ flights: [flight('only', path)], entries: [{ virtual_path: path, local_path: 'only.png', size_bytes: 2, sha256: 'hash' }], failArchive: (id, attempt) => id === 'flights.json' && attempt === 1 });
    await openDeleteFlight('only');
    await waitFor(() => expect(state.mappingPuts).toHaveLength(2));
    expect(state.mapping().entries[0]).toMatchObject({ virtual_path: path, sha256: 'hash' });
    expect((state.documents['flights.json'] as FlightRecord[])[0].id).toBe('only');
    expect(screen.getByRole('checkbox', { name: 'Select only', hidden: true })).toBeTruthy();
  });

  it('scoped archive compensation preserves discoveries and unrelated hash updates made while archive persistence waits', async () => {
    const path = '20260101ca0020a0.png';
    const unrelated = 'objects/unrelated.png';
    const archiveStarted = deferred(); const allowArchiveFailure = deferred();
    const state = setup({
      flights: [flight('only', path)],
      entries: [
        { virtual_path: path, local_path: 'only.png', size_bytes: 2, sha256: 'owned' },
        { virtual_path: unrelated, local_path: 'unrelated.png', size_bytes: 3, sha256: 'old' },
      ],
      localFiles: [{ local_path: 'only.png', size_bytes: 2 }, { local_path: 'unrelated.png', size_bytes: 3 }],
      beforeArchiveWrite: async (id) => { if (id === 'flights.json') { archiveStarted.resolve(); await allowArchiveFailure.promise; } },
      failArchive: (id) => id === 'flights.json',
    });
    const deletion = openDeleteFlight('only');
    await archiveStarted.promise;
    expect(state.mapping().entries.find((entry) => entry.local_path === 'only.png')?.virtual_path).toBe('inbox/only.png');

    state.setLocalFiles([
      { local_path: 'only.png', size_bytes: 2 }, { local_path: 'unrelated.png', size_bytes: 3 }, { local_path: 'new.png', size_bytes: 4 },
    ]);
    state.setServerMapping({ entries: state.mapping().entries.map((entry) => entry.local_path === 'unrelated.png' ? { ...entry, sha256: 'new' } : entry) });
    await act(() => state.resources().refresh());
    expect(state.mapping().entries.find((entry) => entry.local_path === 'new.png')?.virtual_path).toBe('inbox/new.png');

    allowArchiveFailure.resolve();
    await deletion;
    await waitFor(() => expect(state.mapping().entries.find((entry) => entry.local_path === 'only.png')?.virtual_path).toBe(path));
    expect(state.mapping().entries.find((entry) => entry.local_path === 'unrelated.png')?.sha256).toBe('new');
    expect(state.mapping().entries.find((entry) => entry.local_path === 'new.png')?.virtual_path).toBe('inbox/new.png');
    expect((state.documents['flights.json'] as FlightRecord[]).map((item) => item.id)).toEqual(['only']);
    expect(screen.getByRole('checkbox', { name: 'Select only', hidden: true })).toBeTruthy();
  });

  it('rolls back an already-written flights document when the second coordinated archive document fails', async () => {
    const path = '20260101ca0010a0.png';
    const airline = { ...AIRLINE, symbolLogoResourcePath: path };
    const state = setup({ flights: [flight('primary', path)], airlines: [airline], entries: [{ virtual_path: path, local_path: 'cross.png', size_bytes: 2 }], failArchive: (id) => id === 'airlines.json' });
    await openDeleteFlight('primary');
    await waitFor(() => expect(state.archivePuts.map((put) => put.id)).toEqual(['flights.json', 'airlines.json', 'airlines.json', 'flights.json']));
    expect((state.documents['flights.json'] as FlightRecord[])[0].id).toBe('primary');
    expect((state.documents['airlines.json'] as Airline[])[0].symbolLogoResourcePath).toBe(path);
    expect(state.mapping().entries[0].virtual_path).toBe(path);
  });
});
