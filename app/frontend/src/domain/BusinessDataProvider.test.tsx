// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { act, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../test-fixtures/business-data-v1.json';
import {
  BusinessDataProvider,
  DirtyBusinessDataError,
  useBusinessData,
  type ArchiveTransport,
  type BusinessDataContextValue,
} from './BusinessDataProvider';
import {
  BUSINESS_DATA_DOCUMENT_IDS,
  BUSINESS_DATA_MANIFEST,
  aggregateBusinessData,
  parseBusinessDataManifest,
  splitBusinessData,
} from './archiveV2';
import { parseBusinessDataV1 } from './schemaV1';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function archiveDocuments() {
  const data = parseBusinessDataV1(fixture.validDocument);
  return { 'manifest.json': BUSINESS_DATA_MANIFEST, ...splitBusinessData(data) } as unknown as Record<string, Json>;
}

function transportFor(documents = archiveDocuments()): ArchiveTransport & { puts: Array<{ id: string; value: Json }> } {
  const puts: Array<{ id: string; value: Json }> = [];
  return {
    puts,
    getArchiveDocument: vi.fn(async (_appId, documentId) => {
      if (!(documentId in documents)) throw new Error(`missing ${documentId}`);
      return structuredClone(documents[documentId]);
    }),
    putArchiveDocument: vi.fn(async (_appId, documentId, value) => { puts.push({ id: documentId, value: structuredClone(value) }); }),
    deleteArchiveDocument: vi.fn(async () => undefined),
  };
}

let current: BusinessDataContextValue | null = null;
function Capture() { current = useBusinessData(); return null; }
function mount(transport: ArchiveTransport, children: ReactNode = <Capture />) {
  current = null;
  return render(<BusinessDataProvider transport={transport} dependencies={{ now: () => '2030-01-02T03:04:05Z', newId: () => 'fixed-id' }}>{children}</BusinessDataProvider>);
}
async function ready() {
  await waitFor(() => expect(current?.phase).toBe('ready'));
  return current!;
}

describe('v2 split archive', () => {
  it('round-trips the golden aggregate through exactly five documents', () => {
    const data = parseBusinessDataV1(fixture.validDocument);
    const documents = splitBusinessData(data);
    expect(Object.keys(documents)).toEqual(BUSINESS_DATA_DOCUMENT_IDS);
    expect(aggregateBusinessData(documents)).toEqual(data);
  });

  it.each([
    null,
    {},
    { ...BUSINESS_DATA_MANIFEST, formatVersion: 2 },
    { ...BUSINESS_DATA_MANIFEST, businessDataSchemaVersion: 2 },
    { ...BUSINESS_DATA_MANIFEST, documents: [...BUSINESS_DATA_DOCUMENT_IDS].reverse() },
    { ...BUSINESS_DATA_MANIFEST, extra: true },
  ])('rejects an invalid fixed manifest', (manifest) => {
    expect(() => parseBusinessDataManifest(manifest)).toThrow();
  });
});

describe('BusinessDataProvider', () => {
  it('loads the manifest and all documents, and reports missing or invalid archives without creating one', async () => {
    const ok = transportFor();
    const loadedView = mount(ok);
    const value = await ready();
    expect(value.data).toEqual(parseBusinessDataV1(fixture.validDocument));
    expect(ok.getArchiveDocument).toHaveBeenCalledTimes(6);
    expect(ok.putArchiveDocument).not.toHaveBeenCalled();
    loadedView.unmount();

    const invalid = transportFor({ ...archiveDocuments(), 'manifest.json': {} });
    const invalidView = mount(invalid);
    await waitFor(() => expect(current?.phase).toBe('error'));
    expect(current?.loadError).toBeInstanceOf(Error);
    expect(invalid.putArchiveDocument).not.toHaveBeenCalled();
    invalidView.unmount();

    const missing = transportFor();
    vi.mocked(missing.getArchiveDocument).mockRejectedValueOnce(new Error('archive missing'));
    mount(missing);
    await waitFor(() => expect(current?.phase).toBe('error'));
    expect(current?.loadError?.message).toBe('archive missing');
    expect(missing.putArchiveDocument).not.toHaveBeenCalled();
  });

  it('uses injected time and IDs, updates synchronously, and serializes rapid saves', async () => {
    const first = deferred(), second = deferred();
    const transport = transportFor();
    vi.mocked(transport.putArchiveDocument)
      .mockImplementationOnce(async (_app, id, value) => { transport.puts.push({ id, value: value as Json }); await first.promise; })
      .mockImplementationOnce(async (_app, id, value) => { transport.puts.push({ id, value: value as Json }); await second.promise; });
    mount(transport);
    const value = await ready();
    let createdId = '';
    act(() => {
      createdId = value.createFlight(fixture.normalization.flightInput).id;
      value.updateFlight(createdId, { notes: 'second' });
    });
    expect(createdId).toBe('fixed-id');
    expect(current?.data?.flights.at(-1)?.updatedAt).toBe('2030-01-02T03:04:05Z');
    expect(current?.data?.flights.at(-1)?.notes).toBe('second');
    await waitFor(() => expect(transport.putArchiveDocument).toHaveBeenCalledTimes(1));
    first.resolve();
    await waitFor(() => expect(transport.putArchiveDocument).toHaveBeenCalledTimes(2));
    expect(current?.documents['flights.json'].dirty).toBe(true);
    second.resolve();
    await act(async () => { await current!.whenIdle(); });
    expect(current?.documents['flights.json'].dirty).toBe(false);
    expect((transport.puts[0].value as Json[]).at(-1)).not.toEqual((transport.puts[1].value as Json[]).at(-1));
  });

  it('keeps failed working data dirty, retries the latest snapshot, and continues another document', async () => {
    const transport = transportFor();
    vi.mocked(transport.putArchiveDocument)
      .mockRejectedValueOnce(new Error('flight write failed'))
      .mockResolvedValue(undefined)
      .mockResolvedValue(undefined);
    mount(transport);
    const value = await ready();
    act(() => {
      value.updateFlight('flight-1', { notes: 'failed then newer' });
      value.updateSettings({ theme: 'dark' });
    });
    await act(async () => { await current!.whenIdle(); });
    expect(current?.documents['flights.json'].dirty).toBe(true);
    expect(current?.documents['flights.json'].error?.message).toBe('flight write failed');
    expect(current?.documents['settings.json'].dirty).toBe(false);
    const callsBeforeAwait = vi.mocked(transport.putArchiveDocument).mock.calls.length;
    await expect(current!.saveDocument('flights.json')).rejects.toThrow('flight write failed');
    expect(vi.mocked(transport.putArchiveDocument)).toHaveBeenCalledTimes(callsBeforeAwait);
    await act(async () => { await current!.retryDocument('flights.json'); });
    await act(async () => { await current!.whenIdle(); });
    expect(current?.documents['flights.json'].dirty).toBe(false);
    const latest = vi.mocked(transport.putArchiveDocument).mock.calls.at(-1)?.[2] as unknown as Array<{ notes: string }>;
    expect(latest[0].notes).toBe('failed then newer');
  });

  it('saveAll writes five snapshots through the queue and gates the manifest on complete success', async () => {
    const transport = transportFor();
    vi.mocked(transport.putArchiveDocument).mockImplementation(async (_app, id, value) => {
      transport.puts.push({ id, value: value as Json });
      if (id === 'airports.json') throw new Error('no airport save');
    });
    mount(transport);
    await ready();
    let result!: Awaited<ReturnType<BusinessDataContextValue['saveAll']>>;
    await act(async () => { result = await current!.saveAll(); });
    expect(transport.puts.map(({ id }) => id)).toEqual(BUSINESS_DATA_DOCUMENT_IDS);
    expect(result.failed).toEqual(['airports.json']);
    expect(current?.saveAllProgress).toMatchObject({ status: 'failed', completed: 5, total: 5, failed: ['airports.json'] });
    expect(transport.puts.some(({ id }) => id === 'manifest.json')).toBe(false);

    vi.mocked(transport.putArchiveDocument).mockImplementation(async (_app, id, value) => { transport.puts.push({ id, value: value as Json }); });
    await act(async () => { result = await current!.saveAll(); });
    expect(result.failed).toEqual([]);
    expect(transport.puts.at(-1)).toEqual({ id: 'manifest.json', value: BUSINESS_DATA_MANIFEST });
    expect(current?.saveAllProgress.status).toBe('succeeded');
  });

  it('imports validated data, exports the latest dirty aggregate, and blocks blind reload', async () => {
    const blocked = deferred();
    const transport = transportFor();
    vi.mocked(transport.putArchiveDocument).mockImplementation(async () => { await blocked.promise; });
    mount(transport);
    await ready();
    const imported = { ...fixture.validDocument, settings: { imported: 'yes' } };
    let importPromise!: Promise<unknown>;
    act(() => { importPromise = current!.importBusinessData(imported); });
    expect(JSON.parse(current!.exportBusinessData())).toEqual(parseBusinessDataV1(imported));
    await expect(current!.reload()).rejects.toBeInstanceOf(DirtyBusinessDataError);
    expect(current?.data?.settings).toEqual({ imported: 'yes' });
    blocked.resolve();
    await act(async () => { await importPromise; });
    expect(vi.mocked(transport.putArchiveDocument).mock.calls.map((call) => call[1])).toEqual([...BUSINESS_DATA_DOCUMENT_IDS, 'manifest.json']);
  });

  it('allows an explicit discard reload after a failed dirty save', async () => {
    const server = archiveDocuments();
    const transport = transportFor(server);
    vi.mocked(transport.putArchiveDocument).mockRejectedValueOnce(new Error('offline'));
    mount(transport);
    await ready();
    act(() => { current!.updateFlight('flight-1', { notes: 'local unsaved' }); });
    await act(async () => { await current!.whenIdle(); });
    const serverFlights = structuredClone(server['flights.json']) as Array<{ notes: string }>;
    serverFlights[0].notes = 'server copy';
    server['flights.json'] = serverFlights;
    await act(async () => { await current!.reload({ discardChanges: true }); });
    expect(current?.phase).toBe('ready');
    expect(current?.data?.flights[0].notes).toBe('server copy');
    expect(current?.documents['flights.json'].dirty).toBe(false);
  });
});
