// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause
// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ResourceReviewRow, ResourceReviewSnapshot, ResourceUse } from '../api/types';
import { LanguageProvider, useTranslation } from '../i18n';
import { HASH_ALGORITHMS } from '../rfg/api';
import { AppStateProvider } from '../state/AppState';
import { ResourceMappingsPage } from './ResourceMappingsPage';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const none = { ignore: false, unignore: false, release: false, fingerprint: false, rematchTarget: false, rematchCandidate: false };
const flightUse: ResourceUse = { kind: 'flight', id: 'f1', airlineCode: 'SF', flightNumber: '12', departureDate: '2026-01-02', role: 'paperBoardingPassFront' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function row(overrides: Partial<ResourceReviewRow>): ResourceReviewRow {
  return { virtualPath: 'objects/live.png', localPath: '/local/live.png', state: 'mapped', present: true, sizeBytes: 14, fingerprints: [], uses: [], capabilities: { ...none, release: true }, ...overrides };
}
const baseRows = [
  row({ virtualPath: 'objects/missing.png', localPath: '/gone/missing.png', state: 'missing', present: false, sizeBytes: 1536, fingerprints: ['sha256'], capabilities: { ...none, rematchTarget: true } }),
  row({ virtualPath: 'inbox/new.png', localPath: '/local/new.png', state: 'pending', sizeBytes: 12, capabilities: { ...none, ignore: true, rematchCandidate: true } }),
  row({ virtualPath: 'ignore/old.png', localPath: '/local/old.png', state: 'ignored', sizeBytes: 13, capabilities: { ...none, unignore: true } }),
  row({}),
];

function snapshot(rows = baseRows, revision = '"v1"'): ResourceReviewSnapshot { return { revision, rows }; }

function LanguageToggle() {
  const { toggleLanguage } = useTranslation();
  return <button type="button" onClick={toggleLanguage}>toggle language</button>;
}

function renderPage(handler?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handled = await handler?.(url, init);
    if (handled) return handled;
    if (url.includes('/resources/reconcile') || url.includes('/resources/review')) return { ok: true, json: async () => snapshot() } as Response;
    return { ok: true, json: async () => ({ count: 1, applied: 0, ambiguous: [], unmatched: [] }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<LanguageProvider><AppStateProvider><LanguageToggle /><ResourceMappingsPage /></AppStateProvider></LanguageProvider>);
  return fetchMock;
}

it('does not reconcile again when the language changes', async () => {
  const fetchMock = renderPage();
  await screen.findByRole('table');
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/resources/reconcile'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'toggle language' }));
  await screen.findByText('资源映射');
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/resources/reconcile'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'toggle language' }));
});

it('uses reconcile snapshot, keeps All browse-only, and applies the default status/virtual-path ordering', async () => {
  const fetchMock = renderPage();
  const table = await screen.findByRole('table');
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/resources/reconcile'))).toBe(true);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/sync') || String(url).includes('/v1/meta/map'))).toBe(false);
  expect(within(table).queryByRole('checkbox')).toBeNull();
  expect(screen.getByRole('tablist', { name: 'Resource mapping filters' })).toBeTruthy();
  const bodyRows = within(table).getAllByRole('row').slice(1);
  expect(bodyRows.map((item) => item.textContent)).toEqual([
    expect.stringContaining('objects/missing.png'),
    expect.stringContaining('inbox/new.png'),
    expect.stringContaining('objects/live.png'),
    expect.stringContaining('ignore/old.png'),
  ]);
});

it('selects and reverses the mandatory second sort from both its direction control and label', async () => {
  renderPage();
  const table = await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: 'Status' })); // release the default first sort

  fireEvent.click(screen.getByRole('button', { name: 'Sort Local File; current direction ascending' }));
  expect(within(table).getAllByRole('row')[1].textContent).toContain('/gone/missing.png');
  expect(screen.getByRole('button', { name: 'Local File' }).closest('th')?.getAttribute('aria-sort')).toBe('ascending');

  fireEvent.click(screen.getByRole('button', { name: 'Local File' }));
  expect(within(table).getAllByRole('row')[1].textContent).toContain('/local/old.png');
  expect(screen.getByRole('button', { name: 'Local File' }).closest('th')?.getAttribute('aria-sort')).toBe('descending');
});

it('activates, releases, and replaces the optional first sort from header controls', async () => {
  renderPage();
  await screen.findByRole('table');
  const statusHeader = screen.getByRole('button', { name: 'Status' }).closest('th')!;
  const usageHeader = screen.getByRole('button', { name: 'Usage' }).closest('th')!;
  const fingerprintsHeader = screen.getByRole('button', { name: 'Fingerprints' }).closest('th')!;
  expect(statusHeader.getAttribute('aria-sort')).toBe('ascending');

  fireEvent.click(screen.getByRole('button', { name: 'Status' }));
  expect(statusHeader.getAttribute('aria-sort')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
  expect(usageHeader.getAttribute('aria-sort')).toBe('ascending');
  fireEvent.click(screen.getByRole('button', { name: 'Sort Fingerprints; current direction ascending' }));
  expect(usageHeader.getAttribute('aria-sort')).toBeNull();
  expect(fingerprintsHeader.getAttribute('aria-sort')).toBe('ascending');
  fireEvent.click(screen.getByRole('button', { name: 'Sort Fingerprints; current direction ascending' }));
  expect(fingerprintsHeader.getAttribute('aria-sort')).toBe('descending');
});

it('groups by first-sort presence and reverses the group direction', async () => {
  const rows = [
    row({ virtualPath: 'objects/a-used.png', uses: [flightUse] }),
    row({ virtualPath: 'objects/z-unused.png', uses: [] }),
  ];
  renderPage((url) => url.includes('/resources/reconcile') ? ({ ok: true, json: async () => snapshot(rows) } as Response) : undefined as never);
  const table = await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
  expect(within(table).getAllByRole('row')[1].textContent).toContain('objects/z-unused.png');
  fireEvent.click(screen.getByRole('button', { name: 'Sort Usage; current direction ascending' }));
  expect(within(table).getAllByRole('row')[1].textContent).toContain('objects/a-used.png');
});

it('sorts sizes numerically and keeps missing sizes last in both directions', async () => {
  const rows = [
    row({ virtualPath: 'objects/none.png', sizeBytes: null }),
    row({ virtualPath: 'objects/twenty.png', sizeBytes: 20 }),
    row({ virtualPath: 'objects/ten.png', sizeBytes: 10 }),
  ];
  renderPage((url) => url.includes('/resources/reconcile') ? ({ ok: true, json: async () => snapshot(rows) } as Response) : undefined as never);
  const table = await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: 'Sort Size; current direction ascending' }));
  expect(within(table).getAllByRole('row').slice(1).map((item) => item.textContent)).toEqual([
    expect.stringContaining('objects/ten.png'),
    expect.stringContaining('objects/twenty.png'),
    expect.stringContaining('objects/none.png'),
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Sort Size; current direction ascending' }));
  expect(within(table).getAllByRole('row').slice(1).map((item) => item.textContent)).toEqual([
    expect.stringContaining('objects/twenty.png'),
    expect.stringContaining('objects/ten.png'),
    expect.stringContaining('objects/none.png'),
  ]);
});

it('cycles each path display independently without changing the active sort column or row order', async () => {
  const rows = [
    row({ virtualPath: 'objects/alpha/z.png', localPath: '/source/alpha/z.png' }),
    row({ virtualPath: 'objects/beta/a.png', localPath: '/source/beta/a.png' }),
  ];
  renderPage((url) => url.includes('/resources/reconcile') ? ({ ok: true, json: async () => snapshot(rows) } as Response) : undefined as never);
  const table = await screen.findByRole('table');
  const bodyRows = () => within(table).getAllByRole('row').slice(1);
  expect(bodyRows()[0].textContent).toContain('objects/alpha/z.png');
  expect(screen.getByRole('button', { name: 'Resource Path' }).closest('th')?.getAttribute('aria-sort')).toBe('ascending');

  fireEvent.click(screen.getByRole('button', { name: 'Resource Path display mode 1' }));
  expect(bodyRows()[0].textContent).toContain('z.png');
  expect(bodyRows()[1].textContent).toContain('a.png');
  fireEvent.click(screen.getByRole('button', { name: 'Resource Path display mode 2' }));
  expect(bodyRows()[0].textContent).toContain('objects/…/z.png');
  fireEvent.click(screen.getByRole('button', { name: 'Resource Path display mode 3' }));
  expect(bodyRows()[0].textContent).toContain('objects/alpha/z.png');
  expect(screen.getByRole('button', { name: 'Resource Path' }).closest('th')?.getAttribute('aria-sort')).toBe('ascending');

  fireEvent.click(screen.getByRole('button', { name: 'Local File display mode 1' }));
  expect(bodyRows()[0].textContent).not.toContain('/source/alpha/z.png');
  expect(bodyRows()[0].textContent).toContain('z.png');
});

it('labels row selection checkboxes with the action for the current filter', async () => {
  const rows = [
    row({ virtualPath: 'objects/missing.png', state: 'missing', present: false, capabilities: { ...none, rematchTarget: true } }),
    row({ virtualPath: 'inbox/new.png', state: 'pending', capabilities: { ...none, ignore: true, rematchCandidate: true } }),
    row({ virtualPath: 'ignore/old.png', state: 'ignored', capabilities: { ...none, unignore: true } }),
    row({ virtualPath: 'objects/live.png', uses: [flightUse], capabilities: { ...none, fingerprint: true } }),
  ];
  renderPage((url) => url.includes('/resources/reconcile') ? ({ ok: true, json: async () => snapshot(rows) } as Response) : undefined as never);
  await screen.findByRole('table');

  fireEvent.click(screen.getByRole('tab', { name: /rebuild mapping/i }));
  expect(screen.getByRole('checkbox', { name: 'Select objects/missing.png to rematch' })).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Select inbox/new.png to rematch' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /missing source/i }));
  expect(screen.getByRole('checkbox', { name: 'Select objects/missing.png to rematch' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /pending/i }));
  expect(screen.getByRole('checkbox', { name: 'Select inbox/new.png to ignore' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /ignored/i }));
  expect(screen.getByRole('checkbox', { name: 'Select ignore/old.png to restore' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /^mapped/i }));
  expect(screen.getByRole('checkbox', { name: 'Select objects/live.png for fingerprint calculation' })).toBeTruthy();
});

it('rebuild combines authorized targets/candidates and safely highlights full-field search', async () => {
  renderPage();
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /rebuild mapping/i }));
  expect(within(screen.getByRole('table')).getAllByRole('checkbox')).toHaveLength(3);
  fireEvent.change(screen.getByLabelText('Search Mapping Fields'), { target: { value: 'missing' } });
  expect(document.querySelector('mark')?.textContent.toLowerCase()).toBe('missing');
  fireEvent.change(screen.getByLabelText('Search Mapping Fields'), { target: { value: '1.5 KiB' } });
  expect([...document.querySelectorAll('mark')].some((mark) => mark.textContent === '1.5 KiB')).toBe(true);
});

it('keeps All actions read-only but exposes status-page actions from capabilities', async () => {
  renderPage();
  await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: 'Ignore Resource' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /pending/i }));
  const inbox = screen.getByText('inbox/new.png').closest('tr')!;
  expect(within(inbox).getByRole('button', { name: 'Ignore Resource' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /ignored/i }));
  expect(within(screen.getByText('ignore/old.png').closest('tr')!).getByRole('button', { name: /restore/i })).toBeTruthy();
});

it('preserves multi-selection when a manual rematch picker is opened and cancelled', async () => {
  const rows = [
    row({ virtualPath: 'objects/one.png', state: 'missing', present: false, capabilities: { ...none, rematchTarget: true } }),
    row({ virtualPath: 'objects/two.png', state: 'missing', present: false, capabilities: { ...none, rematchTarget: true } }),
    row({ virtualPath: 'inbox/candidate.png', state: 'pending', capabilities: { ...none, ignore: true, rematchCandidate: true } }),
  ];
  renderPage((url) => url.includes('/resources/reconcile') ? ({ ok: true, json: async () => snapshot(rows) } as Response) : undefined as never);
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /missing source/i }));
  const one = screen.getByText('objects/one.png').closest('tr')!;
  const two = screen.getByText('objects/two.png').closest('tr')!;
  fireEvent.click(within(one).getByRole('checkbox'));
  fireEvent.click(within(two).getByRole('checkbox'));
  fireEvent.click(within(one).getByRole('button', { name: 'Manual rematch…' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect((within(screen.getByText('objects/one.png').closest('tr')!).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  expect((within(screen.getByText('objects/two.png').closest('tr')!).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
});

it('keeps same-tab selection across searches', async () => {
  const rows = [
    row({ virtualPath: 'objects/one.png', state: 'missing', present: false, capabilities: { ...none, rematchTarget: true } }),
    row({ virtualPath: 'objects/two.png', state: 'missing', present: false, capabilities: { ...none, rematchTarget: true } }),
  ];
  renderPage((url) => url.includes('/resources/reconcile') ? ({ ok: true, json: async () => snapshot(rows) } as Response) : undefined as never);
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /missing source/i }));
  fireEvent.click(within(screen.getByText('objects/one.png').closest('tr')!).getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Search Mapping Fields'), { target: { value: 'two.png' } });
  expect(screen.queryByText('objects/one.png')).toBeNull();
  fireEvent.change(screen.getByLabelText('Search Mapping Fields'), { target: { value: '' } });
  expect((within(screen.getByText('objects/one.png').closest('tr')!).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
});

it('selects and clears all selectable rows even when the tab contains a non-selectable row', async () => {
  const rows = [
    row({ virtualPath: 'objects/selectable.png', state: 'missing', present: false, capabilities: { ...none, rematchTarget: true } }),
    row({ virtualPath: 'objects/locked.png', state: 'missing', present: false, capabilities: none }),
  ];
  renderPage((url) => url.includes('/resources/reconcile') ? ({ ok: true, json: async () => snapshot(rows) } as Response) : undefined as never);
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /missing source/i }));
  const selectAll = screen.getByRole('checkbox', { name: 'Select All' }) as HTMLInputElement;
  fireEvent.click(selectAll);
  expect((within(screen.getByText('objects/selectable.png').closest('tr')!).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  expect(selectAll.checked).toBe(true);
  fireEvent.click(selectAll);
  expect((within(screen.getByText('objects/selectable.png').closest('tr')!).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});

it('opens AutoRematchDialog for selected missing targets and submits the auto command', async () => {
  let requestBody: unknown;
  renderPage((url, init) => {
    if (url.includes('/resources/rematch')) {
      requestBody = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ applied: 1, ambiguous: [], unmatched: [], revision: '"v2"' }) } as Response;
    }
    return undefined as never;
  });
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /missing source/i }));
  fireEvent.click(within(screen.getByText('objects/missing.png').closest('tr')!).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Auto-rematch…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Auto-rematch' });
  fireEvent.click(await within(dialog).findByText('inbox/new.png'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rematch' }));
  await waitFor(() => expect(requestBody).toEqual({
    ifMatch: '"v1"',
    mode: 'auto',
    candidateInboxVirtualPaths: ['inbox/new.png'],
    targetVirtualPaths: ['objects/missing.png'],
    algorithms: ['filename', 'sizeBytes'],
  }));
});

it('keeps inbox actions limited to row/batch ignore with no rematch entry point', async () => {
  let ignored: unknown;
  renderPage((url, init) => {
    if (url.includes('/resources/ignore')) {
      ignored = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ ignored: ['ignore/new.png'], count: 1, revision: 'v2' }) } as Response;
    }
    return undefined as never;
  });
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /pending/i }));

  expect(screen.queryByRole('button', { name: /rematch/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /adjust matching/i })).toBeNull();
  fireEvent.click(within(screen.getByText('inbox/new.png').closest('tr')!).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Ignore Resource (1)' }));
  await waitFor(() => expect(ignored).toEqual({ ifMatch: '"v1"', virtualPaths: ['inbox/new.png'] }));
});

it('manually rematches a missing row to one inbox candidate with an explicit request', async () => {
  let requestBody: unknown;
  renderPage((url, init) => {
    if (url.includes('/resources/rematch')) {
      requestBody = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ applied: 1, ambiguous: [], unmatched: [], revision: 'v2' }) } as Response;
    }
    return undefined as never;
  });
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /missing source/i }));
  fireEvent.click(within(screen.getByText('objects/missing.png').closest('tr')!).getByRole('button', { name: 'Manual rematch…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Manual rematch' });
  expect(within(dialog).queryByText('objects/live.png')).toBeNull();
  fireEvent.click(await within(dialog).findByText('inbox/new.png'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Select Resource' }));
  await waitFor(() => expect(requestBody).toEqual({
    ifMatch: '"v1"',
    mode: 'explicit',
    matches: [{ targetVirtualPath: 'objects/missing.png', candidateInboxVirtualPath: 'inbox/new.png' }],
  }));
});

it('offers manual rematch beside mapped-row actions and submits explicit rematch', async () => {
  let requestBody: unknown;
  renderPage((url, init) => {
    if (url.includes('/resources/reconcile')) return { ok: true, json: async () => snapshot([
      row({ virtualPath: 'objects/live.png', uses: [flightUse], capabilities: { ...none, fingerprint: true } }),
      baseRows[1],
    ]) } as Response;
    if (url.includes('/resources/rematch')) {
      requestBody = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ applied: 1, ambiguous: [], unmatched: [], revision: 'v2' }) } as Response;
    }
    return undefined as never;
  });
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /^mapped/i }));
  const mappedRow = screen.getByText('objects/live.png').closest('tr')!;
  expect(within(mappedRow).getByRole('button', { name: 'Queue fingerprints for this business resource' })).toBeTruthy();
  fireEvent.click(within(mappedRow).getByRole('button', { name: 'Manual rematch…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Manual rematch' });
  fireEvent.click(await within(dialog).findByText('inbox/new.png'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Select Resource' }));
  await waitFor(() => expect(requestBody).toEqual(expect.objectContaining({
    mode: 'explicit',
    matches: [{ targetVirtualPath: 'objects/live.png', candidateInboxVirtualPath: 'inbox/new.png' }],
  })));
});

it('passes selected rebuild inbox rows as preselected candidates and missing rows as fixed targets', async () => {
  renderPage();
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /rebuild mapping/i }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select objects/missing.png to rematch' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select inbox/new.png to rematch' }));
  fireEvent.click(screen.getByRole('button', { name: 'Auto-rematch…' }));

  const dialog = await screen.findByRole('dialog', { name: 'Auto-rematch' });
  expect(within(dialog).getByText('objects/missing.png')).toBeTruthy();
  const candidate = await within(dialog).findByRole('button', { name: /inbox\/new\.png/i });
  expect(candidate.getAttribute('aria-pressed')).toBe('true');
});

it('simplifies a 409 to one warning, clears selection, and refreshes from review', async () => {
  let reviewLoads = 0;
  const fetchMock = renderPage((url, init) => {
    if (url.includes('/resources/ignore')) {
      expect(JSON.parse(String(init?.body))).toEqual({ ifMatch: '"v1"', virtualPaths: ['inbox/new.png'] });
      return { ok: false, status: 409, json: async () => ({ error: { code: 'mapping-conflict', message: 'stale' } }) } as Response;
    }
    if (url.includes('/resources/review')) { reviewLoads += 1; return { ok: true, json: async () => snapshot(baseRows, `"v${reviewLoads + 1}"`) } as Response; }
    return undefined as never;
  });
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /pending/i }));
  fireEvent.click(within(screen.getByText('inbox/new.png').closest('tr')!).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Ignore Resource (1)' }));
  await waitFor(() => expect(reviewLoads).toBe(1));
  expect((within(screen.getByText('inbox/new.png').closest('tr')!).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect(screen.getAllByText('The resource mapping changed. Review the latest state and try again.')).toHaveLength(1);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/resources/review'))).toBe(true);
});

it('refreshes the snapshot after a status action', async () => {
  let reviewed = false;
  renderPage((url) => {
    if (url.includes('/resources/ignore')) { reviewed = true; return { ok: true, json: async () => ({ ignored: ['ignore/new.png'], count: 1, revision: '"v2"' }) } as Response; }
    if (url.includes('/resources/review') && reviewed) return { ok: true, json: async () => snapshot(baseRows.filter((item) => item.virtualPath !== 'inbox/new.png'), '"v2"') } as Response;
    return undefined as never;
  });
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /pending/i }));
  fireEvent.click(within(screen.getByText('inbox/new.png').closest('tr')!).getByRole('button', { name: 'Ignore Resource' }));
  expect(await screen.findByText('No Entries Found')).toBeTruthy();
});

it('reports a committed mutation refresh failure without reporting the mutation as failed', async () => {
  let ignored = false;
  renderPage((url) => {
    if (url.includes('/resources/ignore')) {
      ignored = true;
      return { ok: true, json: async () => ({ ignored: ['inbox/new.png'], count: 1, revision: '"v2"' }) } as Response;
    }
    if (url.includes('/resources/review') && ignored) {
      return { ok: false, status: 503, json: async () => ({ error: { code: 'unavailable', message: 'down' } }) } as Response;
    }
    return undefined as never;
  });
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /pending/i }));
  fireEvent.click(within(screen.getByText('inbox/new.png').closest('tr')!).getByRole('button', { name: 'Ignore Resource' }));
  expect(await screen.findByText('The change was submitted, but its latest status could not be confirmed. Refresh before trying again.')).toBeTruthy();
  expect(screen.queryByText(/Could not ignore resource/)).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
});

it('fingerprints exactly selected rows authorized by the snapshot', async () => {
  const rows = ['one', 'two', 'three'].map((name) => row({ virtualPath: `objects/${name}.png`, uses: [flightUse], capabilities: { ...none, fingerprint: true, release: false } }));
  renderPage((url) => url.includes('/resources/reconcile') ? ({ ok: true, json: async () => snapshot(rows) } as Response) : undefined as never);
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /mapped/i }));
  fireEvent.click(within(screen.getByText('objects/one.png').closest('tr')!).getByRole('checkbox'));
  fireEvent.click(within(screen.getByText('objects/two.png').closest('tr')!).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Fingerprints…' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('objects/one.png')).toBeTruthy();
  expect(within(dialog).getByText('objects/two.png')).toBeTruthy();
  expect(within(dialog).queryByText('objects/three.png')).toBeNull();
});

it('submits only each fingerprint target\'s missing algorithms in incremental mode', async () => {
  const rows = [
    row({ virtualPath: 'objects/md5.png', fingerprints: ['md5'], uses: [flightUse], capabilities: { ...none, fingerprint: true } }),
    row({ virtualPath: 'objects/sha.png', fingerprints: ['sha256'], uses: [flightUse], capabilities: { ...none, fingerprint: true } }),
  ];
  const requests: Array<{ virtualPaths: string[]; algorithms: string[] }> = [];
  renderPage((url, init) => {
    if (url.includes('/resources/reconcile')) return { ok: true, json: async () => snapshot(rows) } as Response;
    if (url.includes('/resources/fingerprints')) {
      requests.push(JSON.parse(String(init?.body)) as { virtualPaths: string[]; algorithms: string[] });
      return { ok: true, json: async () => ({ task: { id: `task-${requests.length}`, total: 1 } }) } as Response;
    }
    return undefined as never;
  });
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /mapped/i }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select All' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fingerprints…' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue Calculation' }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ virtualPaths: ['objects/md5.png'], algorithms: HASH_ALGORITHMS.filter((algorithm) => algorithm !== 'md5') }),
    expect.objectContaining({ virtualPaths: ['objects/sha.png'], algorithms: HASH_ALGORITHMS.filter((algorithm) => algorithm !== 'sha256') }),
  ]));
});

it('renders the backend horizontal-dark airline usage role', async () => {
  const rows = [row({ uses: [{ kind: 'airline', code: 'SF', role: 'horizontal-dark' }] })];
  renderPage((url) => url.includes('/resources/reconcile') ? ({ ok: true, json: async () => snapshot(rows) } as Response) : undefined as never);
  await screen.findByRole('table');
  fireEvent.mouseOver(screen.getByText(/1 airline/));
  expect(await screen.findByText('SF · Horizontal dark logo')).toBeTruthy();
});

it('prevents release confirmation re-entry while the request is in flight', async () => {
  const pendingRelease = deferred<Response>();
  let releaseCalls = 0;
  renderPage((url) => {
    if (url.includes('/resources/release')) {
      releaseCalls += 1;
      return pendingRelease.promise;
    }
    return undefined as never;
  });
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('tab', { name: /mapped/i }));
  fireEvent.click(within(screen.getByText('objects/live.png').closest('tr')!).getByRole('button', { name: 'Return to Pending' }));
  const dialog = screen.getByRole('dialog');
  const confirm = within(dialog).getByRole('button', { name: 'Return to Pending' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);

  expect(releaseCalls).toBe(1);
  expect(confirm.hasAttribute('disabled')).toBe(true);
  expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
  await act(async () => pendingRelease.resolve({ ok: true, json: async () => ({ count: 1, revision: '"v2"' }) } as Response));
});
