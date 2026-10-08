// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../i18n';
import type { HashTerminalResult, RfgClient } from '../rfg/api';
import { fakeRfgClient, ResourceTestWrapper } from '../rfg/testFixtures';
import { AppStateProvider } from '../state/AppState';
import { ResourceMappingsPage } from './ResourceMappingsPage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('loads the resource-only inventory without mutating the mapping', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  const client = fakeRfgClient({ entries: [{ virtual_path: 'objects/live.png', local_path: 'live.png' }] }, { local_files: [{ local_path: 'live.png', size_bytes: 1 }] });
  const put = vi.spyOn(client, 'putMapping');
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await waitFor(() => expect(screen.getByText('objects/live.png')).toBeTruthy());
  expect(put).not.toHaveBeenCalled();
  expect(screen.queryByText('Usage')).toBeNull();
});

it('reconciles a catalog scan only when Refresh Resources is explicitly activated', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: { persistence: { mode: 'named-json-documents', writable: true, persistenceError: null }, archiveState: 'ready', activityRevision: null } }), { status: 200 })));
  const client = fakeRfgClient({ entries: [] }, { local_files: [{ local_path: 'new.png', size_bytes: 1 }] });
  const put = vi.spyOn(client, 'putMapping');
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await waitFor(() => expect(screen.getByText('new.png')).toBeTruthy());
  expect(put).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Resources' }));
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(put.mock.calls[0][0]).toEqual({ entries: [{ virtual_path: 'inbox/new.png', local_path: 'new.png', size_bytes: 1 }] });
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
  render(<LanguageProvider><ResourceTestWrapper client={client}><AppStateProvider><ResourceMappingsPage /></AppStateProvider></ResourceTestWrapper></LanguageProvider>);
  await waitFor(() => expect(screen.getByText('objects/a.png')).toBeTruthy());

  fireEvent.click(screen.getByRole('tab', { name: 'Mapped (2)' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select objects/a.png for fingerprint calculation' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select objects/b.svg for fingerprint calculation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fingerprints…' }));

  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Queue Calculation' }));
  await waitFor(() => expect(started.some((entry) => entry.startsWith('a.png:'))).toBe(true));
  expect(started.some((entry) => entry.startsWith('b.svg:'))).toBe(false);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  // The cancelled batch must settle without starting the second stored/support group.
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Queue Calculation' })).toBeTruthy());
  expect(started.some((entry) => entry.startsWith('b.svg:'))).toBe(false);
  expect(client.putMapping).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeNull();
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
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load the resource mapping. Try again.');
  await waitFor(() => expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === '/api/activity' && (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(1));
});
