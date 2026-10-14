// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { LanguageProvider } from '../i18n';
import type { HashTerminalResult, RfgClient } from '../rfg/api';
import { fakeRfgClient, ResourceTestWrapper } from '../rfg/testFixtures';
import { AppStateProvider } from '../state/AppState';
import { ResourceMappingsPage } from './ResourceMappingsPage';
import { useResourceMapping } from '../rfg/ResourceMappingProvider';
import { FeedbackProvider, useFeedback } from '../feedback/FeedbackCenter';

const businessFixture = vi.hoisted(() => ({ referenced: new Set<string>(), ready: true }));
vi.mock('../domain/BusinessDataProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../domain/BusinessDataProvider')>();
  return { ...actual, BusinessDataProvider: ({ children }: { children: ReactNode }) => children, useBusinessData: () => ({
    phase: businessFixture.ready ? 'ready' : 'error',
    data: businessFixture.ready ? { schemaVersion: 1, flights: [], airlines: [], airports: [], aircraftTypes: [], settings: {} } : null,
    hasResourceReferences: (paths: readonly string[]) => paths.some((path) => businessFixture.referenced.has(path)),
  }) };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); businessFixture.referenced.clear(); businessFixture.ready = true; });

function CreatePendingRecovery({ failReads }: { failReads: () => void }) {
  const resources = useResourceMapping();
  return <button onClick={() => { void resources.transition([{ from: 'objects/a.png', to: '20300102zx0007a0.png' }]).then(async (result) => {
    failReads();
    try { await resources.restore(result.recovery); } catch { /* expected test setup */ }
  }); }}>Create Pending Recovery</button>;
}

function FeedbackRecords() {
  const { records } = useFeedback();
  return <output data-testid="feedback-records">{JSON.stringify(records)}</output>;
}

function renderMappingSelection(entries: { virtual_path: string; local_path: string; size_bytes: number }[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  const client = fakeRfgClient(
    { entries },
    { local_files: entries.map(({ local_path, size_bytes }) => ({ local_path, size_bytes })) },
  );
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
}

const inboxSelectionEntries = ['a', 'b', 'c', 'd'].map((name, index) => ({
  virtual_path: `inbox/${name}.png`, local_path: `${name}.png`, size_bytes: index + 1,
}));

it('shift-selects an inclusive pending range in either direction', async () => {
  renderMappingSelection(inboxSelectionEntries);
  fireEvent.click(await screen.findByRole('tab', { name: 'Pending (4)' }));

  fireEvent.click(screen.getByRole('checkbox', { name: 'Select inbox/b.png to ignore' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select inbox/d.png to ignore' }), { shiftKey: true });
  for (const name of ['b', 'c', 'd']) {
    expect((screen.getByRole('checkbox', { name: `Select inbox/${name}.png to ignore` }) as HTMLInputElement).checked).toBe(true);
  }
  expect(screen.getByRole('button', { name: 'Ignore Resource (3)' })).toBeTruthy();

  fireEvent.click(screen.getByRole('checkbox', { name: 'Select All' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select All' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select inbox/d.png to ignore' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select inbox/b.png to ignore' }), { shiftKey: true });
  for (const name of ['b', 'c', 'd']) {
    expect((screen.getByRole('checkbox', { name: `Select inbox/${name}.png to ignore` }) as HTMLInputElement).checked).toBe(true);
  }
});

it('falls back to a normal toggle after search invalidates the selection anchor', async () => {
  renderMappingSelection(inboxSelectionEntries);
  fireEvent.click(await screen.findByRole('tab', { name: 'Pending (4)' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select inbox/a.png to ignore' }));
  fireEvent.change(screen.getByLabelText('Search Mapping Fields'), { target: { value: 'd.png' } });
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Select inbox/a.png to ignore' })).toBeNull());
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select inbox/d.png to ignore' }), { shiftKey: true });
  expect(screen.getByRole('button', { name: 'Ignore Resource (2)' })).toBeTruthy();
});

it('clears the selection anchor when the header checkbox is used', async () => {
  renderMappingSelection(inboxSelectionEntries);
  fireEvent.click(await screen.findByRole('tab', { name: 'Pending (4)' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select inbox/b.png to ignore' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select All' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select All' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select inbox/d.png to ignore' }), { shiftKey: true });
  expect(screen.getByRole('button', { name: 'Ignore Resource (1)' })).toBeTruthy();
  expect((screen.getByRole('checkbox', { name: 'Select inbox/c.png to ignore' }) as HTMLInputElement).checked).toBe(false);
});

it('shift-selects mapped rows in their current visible sorted order', async () => {
  renderMappingSelection(['a', 'b', 'c'].map((name, index) => ({
    virtual_path: `objects/${name}.png`, local_path: `${name}.png`, size_bytes: index + 1,
  })));
  fireEvent.click(await screen.findByRole('tab', { name: 'Mapped (3)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sort Resource Path; current direction ascending' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select objects/c.png for fingerprint calculation' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select objects/a.png for fingerprint calculation' }), { shiftKey: true });
  for (const name of ['a', 'b', 'c']) {
    expect((screen.getByRole('checkbox', { name: `Select objects/${name}.png for fingerprint calculation` }) as HTMLInputElement).checked).toBe(true);
  }
});

it('keeps the initial mapping-null failure in the full error state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  const client = fakeRfgClient({ entries: [] }, { local_files: [] });
  vi.spyOn(client, 'getCatalog').mockRejectedValue(new Error('synthetic initial failure'));
  render(<LanguageProvider><FeedbackProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /><FeedbackRecords /></AppStateProvider></ResourceTestWrapper></FeedbackProvider></LanguageProvider>);
  const retry = await screen.findByRole('button', { name: 'Retry' });
  const errorState = retry.closest<HTMLElement>('[role="alert"]')!;
  expect(errorState.textContent).toContain('Could not load the resource mapping. Try again.');
  expect(within(errorState).getByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Refresh Resources' })).toBeNull();
  expect(JSON.parse(screen.getByTestId('feedback-records').textContent ?? '[]')).toHaveLength(1);
  expect(client.getCatalog).toHaveBeenCalledTimes(1);
});

it('loads the resource-only inventory without mutating the mapping', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  const client = fakeRfgClient({ entries: [{ virtual_path: 'objects/live.png', local_path: 'live.png' }] }, { local_files: [{ local_path: 'live.png', size_bytes: 1 }] });
  const put = vi.spyOn(client, 'putMapping');
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /><FeedbackRecords /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await waitFor(() => expect(screen.getByText('objects/live.png')).toBeTruthy());
  expect(put).not.toHaveBeenCalled();
  expect(screen.queryByText('Usage')).toBeNull();
});

it('publishes a newly scanned catalog file only after registering its inbox mapping', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  const client = fakeRfgClient({ entries: [] }, { local_files: [{ local_path: 'new.png', size_bytes: 1 }] });
  const put = vi.spyOn(client, 'putMapping');
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await waitFor(() => expect(screen.getByText('inbox/new.png')).toBeTruthy());
  expect(put).toHaveBeenCalledTimes(1);
  expect(screen.getByText('inbox/new.png')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Resources' }));
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(put.mock.calls[0][0]).toEqual({ entries: [{ virtual_path: 'inbox/new.png', local_path: 'new.png', size_bytes: 1 }] });
});

it('automatically removes an ignored entry when its source disappears', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  const client = fakeRfgClient({ entries: [{ virtual_path: 'ignore/gone.png', local_path: 'gone.png', size_bytes: 2 }] }, { local_files: [] });
  const put = vi.spyOn(client, 'putMapping');
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await screen.findByRole('tab', { name: 'Ignored (0)' });
  expect(screen.queryByText('ignore/gone.png')).toBeNull();
  await waitFor(() => expect(put).toHaveBeenCalledWith({ entries: [] }));
});

it('allows a missing stable mapping to be released after confirming no local file is deleted', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  const client = fakeRfgClient({ entries: [{ virtual_path: 'objects/gone.png', local_path: 'gone.png', size_bytes: 2, sha256: 'old' }] }, { local_files: [] });
  const put = vi.spyOn(client, 'putMapping');
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  fireEvent.click(await screen.findByRole('tab', { name: 'Missing Source (1)' }));
  const row = screen.getByText('objects/gone.png').closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: 'Release Mapping' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('mappings whose sources are absent are removed');
  expect(dialog.textContent).toContain('Local source files are not deleted');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Release Mapping' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith({ entries: [] }));
});

it('refuses manual release when the latest business data still references the mapping', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  const path = 'objects/referenced.png';
  businessFixture.referenced.add(path);
  const client = fakeRfgClient({ entries: [{ virtual_path: path, local_path: 'referenced.png', size_bytes: 2 }] }, { local_files: [{ local_path: 'referenced.png', size_bytes: 2 }] });
  const put = vi.spyOn(client, 'putMapping');
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /><FeedbackRecords /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  fireEvent.click(await screen.findByRole('tab', { name: 'Mapped (1)' }));
  const row = screen.getByText(path).closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: 'Release Mapping' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Release Mapping' }));
  await waitFor(() => expect(JSON.parse(screen.getByTestId('feedback-records').textContent ?? '[]')).toHaveLength(1));
  const records = JSON.parse(screen.getByTestId('feedback-records').textContent ?? '[]');
  expect(records).toHaveLength(1);
  expect(records[0].message).toMatch(/still used by a flight or airline/i);
  expect(records[0].message).not.toMatch(/could not release/i);
  expect(put).not.toHaveBeenCalled();
});

it('shows a source discovered by a mapping mutation immediately after its confirmed inbox registration', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  let catalog = { local_files: [{ local_path: 'live.png', size_bytes: 1 }] };
  let document = { entries: [{ virtual_path: 'objects/live.png', local_path: 'live.png', size_bytes: 1 }] };
  const client: RfgClient = {
    getCatalog: vi.fn(async () => catalog),
    getMapping: vi.fn(async () => ({ document, etag: null })),
    putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
    computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
  };
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  fireEvent.click(await screen.findByRole('tab', { name: 'Mapped (1)' }));
  catalog = { local_files: [...catalog.local_files, { local_path: 'new.png', size_bytes: 2 }] };
  const row = screen.getByText('objects/live.png').closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: 'Release Mapping' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Release Mapping' }));
  fireEvent.click(await screen.findByRole('tab', { name: 'Pending (2)' }));
  await screen.findByText('inbox/new.png');
  expect(document.entries.find((entry) => entry.local_path === 'new.png')?.virtual_path).toBe('inbox/new.png');
});

it('keeps the confirmed mapping visible, reports registration failure centrally, and retries successfully', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  let catalog = { local_files: [{ local_path: 'stable.png', size_bytes: 1 }] };
  let document = { entries: [{ virtual_path: 'objects/stable.png', local_path: 'stable.png', size_bytes: 1, sha256: 'kept' }] };
  let failWrites = false;
  const client: RfgClient = {
    getCatalog: vi.fn(async () => catalog),
    getMapping: vi.fn(async () => ({ document, etag: null })),
    putMapping: vi.fn(async (next) => {
      if (failWrites) throw new Error('synthetic registration failure');
      document = next as typeof document;
      return next;
    }),
    computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
  };
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await screen.findByText('objects/stable.png');

  catalog = { local_files: [{ local_path: 'stable.png', size_bytes: 1 }, { local_path: 'candidate.png', size_bytes: 2 }] };
  failWrites = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Resources' }));
  await screen.findByText('Could not load the resource mapping. Try again.');
  expect(screen.getByText('objects/stable.png')).toBeTruthy();
  expect(screen.queryByText('inbox/candidate.png')).toBeNull();
  expect(screen.queryAllByRole('alert').some((item) => within(item).queryByRole('button', { name: 'Refresh Resources' }))).toBe(false);

  failWrites = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Resources' }));
  await screen.findByText('inbox/candidate.png');
  expect(document.entries).toEqual([
    { virtual_path: 'objects/stable.png', local_path: 'stable.png', size_bytes: 1, sha256: 'kept' },
    { virtual_path: 'inbox/candidate.png', local_path: 'candidate.png', size_bytes: 2 },
  ]);
  expect(screen.queryAllByRole('alert').some((item) => within(item).queryByRole('button', { name: 'Refresh Resources' }))).toBe(false);
});

it('stops the whole fingerprint handler when a batch is cancelled', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  let document = { entries: [
    { virtual_path: 'objects/a.png', local_path: 'a.png', size_bytes: 1, sha256: 'stored' },
    { virtual_path: 'objects/b.svg', local_path: 'b.svg', size_bytes: 1 },
  ] };
  const catalog = { local_files: [{ local_path: 'a.png', size_bytes: 1 }, { local_path: 'b.svg', size_bytes: 1 }] };
  const started: string[] = [];
  const client: RfgClient = {
    getCatalog: vi.fn(async () => catalog),
    getMapping: vi.fn(async () => ({ document, etag: null })),
    putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
    computeHash: vi.fn(({ local_path, algorithm }, signal?: AbortSignal) => {
      started.push(`${local_path}:${algorithm}`);
      if (local_path === 'a.png') {
        return new Promise<HashTerminalResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return Promise.resolve({ local_path, algorithm, profile: null, status: 'succeeded', value: `${algorithm}-value`, code: 'computed', detail: null, error: null } as HashTerminalResult);
    }),
    getResource: vi.fn(), headResource: vi.fn(),
  };
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /><FeedbackRecords /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await waitFor(() => expect(screen.getByText('objects/a.png')).toBeTruthy());

  fireEvent.click(screen.getByRole('tab', { name: 'Mapped (2)' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select objects/a.png for fingerprint calculation' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select objects/b.svg for fingerprint calculation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fingerprints…' }));

  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Calculate Fingerprints' }));
  await waitFor(() => expect(started.some((entry) => entry.startsWith('a.png:'))).toBe(true));
  expect(started.some((entry) => entry.startsWith('b.svg:'))).toBe(false);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  // The cancelled batch must settle without starting the second stored/support group.
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Calculate Fingerprints' })).toBeTruthy());
  expect(started.some((entry) => entry.startsWith('b.svg:'))).toBe(false);
  expect(client.putMapping).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeNull();
  expect(JSON.parse(screen.getByTestId('feedback-records').textContent ?? '[]')).toHaveLength(0);
});

it('reports one centralized success only after every fingerprint group completes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  let document = { entries: [
    { virtual_path: 'objects/a.png', local_path: 'a.png', size_bytes: 1, sha256: 'stored' },
    { virtual_path: 'objects/b.svg', local_path: 'b.svg', size_bytes: 1 },
  ] };
  const client: RfgClient = {
    getCatalog: vi.fn(async () => ({ local_files: [{ local_path: 'a.png', size_bytes: 1 }, { local_path: 'b.svg', size_bytes: 1 }] })),
    getMapping: vi.fn(async () => ({ document, etag: null })),
    putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
    computeHash: vi.fn(async ({ local_path, algorithm }) => ({ local_path, algorithm, profile: null, status: 'succeeded', value: `${algorithm}-value`, code: 'computed', detail: null, error: null } as HashTerminalResult)),
    getResource: vi.fn(), headResource: vi.fn(),
  };
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /><FeedbackRecords /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await screen.findByText('objects/a.png');
  fireEvent.click(screen.getByRole('tab', { name: 'Mapped (2)' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select objects/a.png for fingerprint calculation' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select objects/b.svg for fingerprint calculation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fingerprints…' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Calculate Fingerprints' }));
  await waitFor(() => expect(JSON.parse(screen.getByTestId('feedback-records').textContent ?? '[]')).toHaveLength(1));
  const records = JSON.parse(screen.getByTestId('feedback-records').textContent ?? '[]');
  expect(records[0]).toMatchObject({ message: 'Fingerprints calculated.', finalState: 'succeeded', context: { action: 'Calculate Fingerprints', resource: 'objects/a.png, objects/b.svg', form: 'Resource Mappings' } });
  expect(client.putMapping).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryAllByRole('alert').filter((alert) => alert.closest('main'))).toHaveLength(0);
});

it('does not report fingerprint success when calculation fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  const document = { entries: [{ virtual_path: 'objects/fail.png', local_path: 'fail.png', size_bytes: 1 }] };
  const client: RfgClient = {
    getCatalog: vi.fn(async () => ({ local_files: [{ local_path: 'fail.png', size_bytes: 1 }] })),
    getMapping: vi.fn(async () => ({ document, etag: null })), putMapping: vi.fn(async (next) => next),
    computeHash: vi.fn(async ({ local_path, algorithm }) => ({ local_path, algorithm, profile: null, status: 'failed', value: null, code: 'hash_failed', detail: null, error: { code: 'synthetic', message: 'synthetic failure', retryable: false } } as HashTerminalResult)),
    getResource: vi.fn(), headResource: vi.fn(),
  };
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /><FeedbackRecords /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await screen.findByText('objects/fail.png');
  fireEvent.click(screen.getByRole('tab', { name: 'Mapped (1)' }));
  const row = screen.getByText('objects/fail.png').closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: 'Calculate fingerprints for this mapped resource' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Calculate Fingerprints' }));
  await waitFor(() => expect(JSON.parse(screen.getByTestId('feedback-records').textContent ?? '[]')).toHaveLength(1));
  const records = JSON.parse(screen.getByTestId('feedback-records').textContent ?? '[]');
  expect(records[0].finalState).toBe('failed');
  expect(records.some((record: { message: string }) => record.message === 'Fingerprints calculated.')).toBe(false);
  expect(screen.queryAllByRole('alert').filter((alert) => alert.closest('main'))).toHaveLength(0);
});

it('best-effort activity reporting failure neither recurses nor hides the working mapping error', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/activity' && init?.method === 'POST') return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = fakeRfgClient({ entries: [] }, { local_files: [] });
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await screen.findByText('No Resource Mappings Yet');
  vi.spyOn(client, 'getCatalog').mockRejectedValue(new Error('catalog unavailable'));

  fireEvent.click(screen.getByRole('button', { name: 'Refresh Resources' }));
  expect((await screen.findAllByRole('alert')).some((alert) => alert.textContent?.includes('Could not load the resource mapping. Try again.'))).toBe(true);
  await waitFor(() => expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === '/api/activity' && (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(1));
});

it('has no recovery control and repairs pending compensation through ordinary refresh', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  let document = { entries: [{ virtual_path: 'objects/a.png', local_path: 'a.png', size_bytes: 1 }] };
  let readsFail = false;
  const client: RfgClient = {
    getCatalog: vi.fn(async () => ({ local_files: [{ local_path: 'a.png', size_bytes: 1 }] })),
    getMapping: vi.fn(async () => { if (readsFail) throw new Error('read unavailable'); return { document, etag: null }; }),
    putMapping: vi.fn(async (next) => { document = next as typeof document; return next; }),
    computeHash: vi.fn(), getResource: vi.fn(), headResource: vi.fn(),
  };
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><CreatePendingRecovery failReads={() => { readsFail = true; }} /><ResourceMappingsPage /><FeedbackRecords /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await screen.findByText('objects/a.png');
  fireEvent.click(screen.getByRole('button', { name: 'Create Pending Recovery' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry Recovery' })).toBeNull());
  readsFail = false;
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Resources' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Resources' }));
  await screen.findByText('objects/a.png');
  expect(JSON.parse(screen.getByTestId('feedback-records').textContent ?? '[]')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Retry Recovery' })).toBeNull();
});
