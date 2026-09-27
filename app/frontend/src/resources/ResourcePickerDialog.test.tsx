// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * View contract of the resource picker dialog: the thumbnail grid serves
 * image thumbnails and shows a centred generic file icon for every
 * non-image or unavailable file; the list view behaves like a file manager
 * (one selectable row per entry, type icon + filename, location, kind and
 * classification state) and never loads image thumbnails. Selection, paging
 * and search operate on the same filtered entries in both views.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ResourceReviewRow } from '../api/types';
import { LanguageProvider, useTranslation } from '../i18n';
import { ResourcePickerDialog } from './ResourcePickerDialog';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const SELECTED: string[] = [];
const IMAGE_PATH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pass.png';

const noCapabilities = { ignore: false, unignore: false, release: false, fingerprint: false, rematchTarget: false, rematchCandidate: false };

function reviewRow(virtualPath: string, localPath: string, overrides: Partial<ResourceReviewRow> = {}): ResourceReviewRow {
  return { virtualPath, localPath, state: 'mapped', present: true, sizeBytes: null, fingerprints: [], uses: [], capabilities: { ...noCapabilities, release: true }, ...overrides };
}

function mockBackend(rows: ResourceReviewRow[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/resources/ignore')) {
        expect(JSON.parse(String(init?.body))).toEqual({ ifMatch: '"v1"', virtualPaths: ['inbox/scan.pdf'] });
        return { ok: true, json: async () => ({ ignored: ['ignore/scan.pdf'], count: 1, revision: '"v2"' }) } as unknown as Response;
      }
      if (url.includes('/api/resources/reconcile')) return { ok: true, json: async () => ({ revision: '"v1"', rows }) } as unknown as Response;
      if (url.includes('/api/resources/review')) return { ok: true, json: async () => ({ revision: '"v2"', rows: rows.filter((row) => row.state !== 'pending') }) } as unknown as Response;
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }),
  );
}

function renderPicker(props: Partial<Parameters<typeof ResourcePickerDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <LanguageProvider>
      <ResourcePickerDialog open title="Attachments" selected={SELECTED} onConfirm={onConfirm} onClose={onClose} {...props} />
    </LanguageProvider>,
  );
  return { onConfirm, onClose };
}

const MIXED_ENTRIES = [
  reviewRow('inbox/scan.pdf', '/local/scan.pdf', { state: 'pending', capabilities: { ...noCapabilities, ignore: true, rematchCandidate: true } }),
  reviewRow('objects/notes.txt', '/local/notes.txt'),
  reviewRow(IMAGE_PATH, '/local/pass.png'),
];
const IN_USE_PATH = 'objects/shared.png';
const IN_USE_ENTRIES = [reviewRow(IN_USE_PATH, '/local/shared.png', {
  uses: [
    { kind: 'flight', id: 'f1', airlineCode: 'SF', flightNumber: '12', departureDate: '2026-01-02', role: 'paperBoardingPassFront' },
    { kind: 'flight', id: 'f1', airlineCode: 'SF', flightNumber: '12', departureDate: '2026-01-02', role: 'attachment' },
    { kind: 'airline', code: 'SF', role: 'horizontal' },
    { kind: 'airline', code: 'SF', role: 'symbol' },
  ],
  capabilities: { ...noCapabilities, fingerprint: true },
})];

describe('ResourcePickerDialog thumbnail view', () => {
  it('ignores a selected inbox file and removes it from the selectable list', async () => {
    mockBackend([reviewRow('inbox/scan.pdf', '/local/scan.pdf', { state: 'pending', capabilities: { ...noCapabilities, ignore: true, rematchCandidate: true } })]);
    const { onConfirm } = renderPicker();
    await screen.findByText('inbox/scan.pdf');
    fireEvent.click(screen.getByText('inbox/scan.pdf'));
    fireEvent.click(screen.getByRole('button', { name: 'Ignore Resource' }));
    expect(await screen.findByText('No Entries Found')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('serves image thumbnails and a centred generic file icon for every non-image file', async () => {
    mockBackend(MIXED_ENTRIES);
    renderPicker();
    await screen.findByText('inbox/scan.pdf');

    // Exactly one thumbnail request: the single image entry.
    const images = document.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe(`/images/${IMAGE_PATH}`);

    // Both non-image files get the generic file icon instead of filename
    // text inside the preview frame; the path stays as the caption below.
    expect(screen.getAllByTestId('InsertDriveFileOutlinedIcon')).toHaveLength(2);
    expect(screen.getByText('inbox/scan.pdf')).toBeTruthy();
    expect(screen.getByText('objects/notes.txt')).toBeTruthy();
  });

  it('keeps mapped resources in use visible, selectable, and clearly contextualized', async () => {
    mockBackend(IN_USE_ENTRIES);
    const { onConfirm } = renderPicker();
    await screen.findByText(IN_USE_PATH);

    expect(screen.getByText('Mapped · in use')).toBeTruthy();
    expect(screen.getByText('1 flight(s) · 1 airline(s)')).toBeTruthy();
    fireEvent.mouseOver(screen.getByText('1 flight(s) · 1 airline(s)'));
    expect(await screen.findByText('SF12 · 2026-01-02 · Paper front')).toBeTruthy();
    expect(await screen.findByText('SF12 · 2026-01-02 · Attachment')).toBeTruthy();
    expect(screen.getByText('SF · Horizontal logo')).toBeTruthy();
    expect(screen.getByText('SF · Symbol logo')).toBeTruthy();
    const cardButton = screen.getByRole('button', { name: new RegExp(IN_USE_PATH) });
    expect(cardButton.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(cardButton);
    expect(cardButton.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /select resource/i }));
    expect(onConfirm).toHaveBeenCalledWith([IN_USE_PATH]);
  });

  it('uses its visible title as the dialog accessible name', async () => {
    mockBackend(MIXED_ENTRIES);
    renderPicker();
    expect(await screen.findByRole('dialog', { name: 'Attachments' })).toBeTruthy();
  });

  it('shows missing mappings as missing sources without loading their thumbnail or allowing a new selection', async () => {
    const missing = reviewRow('objects/lost.png', '/local/lost.png', { state: 'missing', present: false, uses: [{ kind: 'flight', id: 'f1', airlineCode: 'SF', flightNumber: '12', departureDate: '2026-01-02', role: 'attachment' }], capabilities: { ...noCapabilities, rematchTarget: true } });
    mockBackend([missing]);
    const { onConfirm } = renderPicker();
    await screen.findByText(missing.virtualPath!);

    expect(screen.getByText(/missing source/i)).toBeTruthy();
    expect(document.querySelectorAll('img')).toHaveLength(0);
    const card = screen.getByRole('button', { name: new RegExp(missing.virtualPath!) });
    expect(card.hasAttribute('disabled')).toBe(true);
    fireEvent.click(card);
    expect(screen.getByRole('button', { name: /select resource/i }).hasAttribute('disabled')).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('retains a missing mapping that was selected when the dialog opened', async () => {
    const missing = reviewRow('objects/lost.png', '/local/lost.png', { state: 'missing', present: false, capabilities: { ...noCapabilities, rematchTarget: true } });
    mockBackend([missing]);
    const { onConfirm } = renderPicker({ selected: [missing.virtualPath!] });
    await screen.findByText(missing.virtualPath!);

    expect(screen.getByTestId('CheckCircleIcon')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: /select resource/i });
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith([missing.virtualPath]);
  });
});

describe('ResourcePickerDialog list view', () => {
  it('shows file-manager rows with location, kind and classification — and loads no thumbnails', async () => {
    mockBackend(MIXED_ENTRIES);
    renderPicker();
    await screen.findByText('inbox/scan.pdf');

    fireEvent.click(screen.getByRole('button', { name: /list view/i }));

    // One selectable row per entry, single-selection radio semantics.
    const rows = screen.getAllByRole('radio');
    expect(rows).toHaveLength(3);
    // No image thumbnail is loaded in list mode.
    expect(document.querySelectorAll('img')).toHaveLength(0);

    // Inbox entries sort first, then alphabetically: filename, parent
    // folder, kind and state are all visible per row.
    expect(rows[0].textContent).toContain('scan.pdf');
    expect(rows[0].textContent).toContain('inbox');
    expect(rows[0].textContent).toContain('PDF');
    expect(rows[0].textContent).toContain('Pending');
    expect(rows[1].textContent).toContain('pass.png');
    expect(rows[1].textContent).toContain('PNG');
    expect(rows[1].textContent).toContain('Mapped');
    expect(rows[2].textContent).toContain('notes.txt');
    expect(rows[2].textContent).toContain('objects');
    expect(rows[2].textContent).toContain('TXT');
    expect(rows[2].textContent).toContain('Mapped');

    // File-type icons per entry, no generic placeholder needed here.
    expect(screen.getByTestId('PictureAsPdfOutlinedIcon')).toBeTruthy();
    expect(screen.getByTestId('ArticleOutlinedIcon')).toBeTruthy();
    expect(screen.getByTestId('ImageOutlinedIcon')).toBeTruthy();
  });

  it('keeps mapped resources in use selectable with their usage context', async () => {
    mockBackend(IN_USE_ENTRIES);
    const { onConfirm } = renderPicker();
    await screen.findByText(IN_USE_PATH);
    fireEvent.click(screen.getByRole('button', { name: /list view/i }));

    const row = screen.getByRole('radio');
    expect(row.textContent).toContain('shared.png');
    expect(row.textContent).toContain('Mapped · in use');
    expect(row.textContent).toContain('1 flight(s) · 1 airline(s)');
    fireEvent.mouseOver(screen.getByText('1 flight(s) · 1 airline(s)'));
    expect(await screen.findByText('SF12 · 2026-01-02 · Attachment')).toBeTruthy();
    expect(screen.getByText('SF · Horizontal logo')).toBeTruthy();
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /select resource/i }));
    expect(onConfirm).toHaveBeenCalledWith([IN_USE_PATH]);
  });

  it('does not present a stale inbox mapping after sync/catalog refresh', async () => {
    const missing = reviewRow('inbox/stale.pdf', '/local/stale.pdf', { state: 'pending', present: false, capabilities: noCapabilities });
    mockBackend([missing]);
    const { onConfirm } = renderPicker({ selected: [missing.virtualPath!] });
    await screen.findByText('No Entries Found');
    expect(screen.queryByText(missing.virtualPath!)).toBeNull();
    expect(screen.getByRole('button', { name: /select resource/i }).getAttribute('disabled')).not.toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps the selection when switching between list and thumbnail views', async () => {
    mockBackend(MIXED_ENTRIES);
    const { onConfirm } = renderPicker({ multiple: true });
    await screen.findByText('inbox/scan.pdf');

    fireEvent.click(screen.getByRole('button', { name: /list view/i }));
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getAllByRole('checkbox')[0].getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /thumbnail view/i }));
    expect(screen.getByTestId('CheckCircleIcon')).toBeTruthy();
    expect(screen.getByRole('button', { name: /inbox\/scan\.pdf/i }).getAttribute('aria-pressed')).toBe('true');

    const confirm = screen.getByRole('button', { name: /select resource/i });
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(['inbox/scan.pdf']);
  });

  it('toggles selection from the keyboard in single-selection mode', async () => {
    mockBackend(MIXED_ENTRIES);
    renderPicker();
    await screen.findByText('inbox/scan.pdf');

    fireEvent.click(screen.getByRole('button', { name: /list view/i }));
    const firstRow = screen.getAllByRole('radio')[0];
    fireEvent.keyDown(firstRow, { key: 'Enter' });
    expect(firstRow.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(firstRow, { key: ' ' });
    expect(firstRow.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps the selection across pages of the same filtered list', async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      virtualPath: `inbox/file-${String(index).padStart(2, '0')}.pdf`,
      localPath: `/local/file-${index}.pdf`,
    })).map(({ virtualPath, localPath }) => reviewRow(virtualPath, localPath, { state: 'pending', capabilities: { ...noCapabilities, ignore: true, rematchCandidate: true } }));
    mockBackend(many);
    renderPicker();
    await screen.findByText('1–24 of 30');

    fireEvent.click(screen.getByRole('button', { name: /list view/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to page 2' }));
    await screen.findByText('25–30 of 30');

    fireEvent.click(screen.getAllByRole('radio')[0]);
    expect(screen.getAllByRole('radio')[0].getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Go to page 1' }));
    await screen.findByText('1–24 of 30');
    const confirm = screen.getByRole('button', { name: /select resource/i });
    expect(confirm.hasAttribute('disabled')).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function LanguageToggle() {
  const { toggleLanguage } = useTranslation();
  return <button type="button" onClick={toggleLanguage}>toggle language</button>;
}

describe('ResourcePickerDialog load lifetime', () => {
  it('does not reload or reset selection, search, or page when a parent passes an equivalent new selected array', async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      virtualPath: `inbox/file-${String(index).padStart(2, '0')}.pdf`,
      localPath: `/local/file-${index}.pdf`,
    })).map(({ virtualPath, localPath }) => reviewRow(virtualPath, localPath, { state: 'pending', capabilities: { ...noCapabilities, ignore: true, rematchCandidate: true } }));
    mockBackend(many);
    const fetchMock = vi.mocked(fetch);
    const props = { open: true, title: 'Attachments', selected: [] as string[], multiple: true, onConfirm: vi.fn(), onClose: vi.fn() };
    const view = render(<LanguageProvider><ResourcePickerDialog {...props} /></LanguageProvider>);
    await screen.findByText('1–24 of 30');

    fireEvent.change(screen.getByLabelText('Search Resources'), { target: { value: 'file' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go to page 2' }));
    fireEvent.click(screen.getByText('inbox/file-24.pdf'));
    const requestCount = fetchMock.mock.calls.length;

    view.rerender(<LanguageProvider><ResourcePickerDialog {...props} selected={[]} /></LanguageProvider>);

    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
    expect(screen.getByLabelText('Search Resources')).toHaveProperty('value', 'file');
    expect(screen.getByText('25–30 of 30')).toBeTruthy();
    expect(screen.getByTestId('CheckCircleIcon')).toBeTruthy();
  });

  it('ignores an earlier opening response that arrives after a newer opening response', async () => {
    const mappings = [deferred<Response>(), deferred<Response>()];
    const mappingSignals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/resources/reconcile')) {
        mappingSignals.push(init?.signal as AbortSignal);
        return mappings[mappingSignals.length - 1].promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const props = { title: 'Attachments', selected: [] as string[], onConfirm: vi.fn(), onClose: vi.fn() };
    const view = render(<LanguageProvider><ResourcePickerDialog open {...props} /></LanguageProvider>);
    await waitFor(() => expect(mappingSignals).toHaveLength(1));
    view.rerender(<LanguageProvider><ResourcePickerDialog open={false} {...props} /></LanguageProvider>);
    view.rerender(<LanguageProvider><ResourcePickerDialog open {...props} /></LanguageProvider>);
    await waitFor(() => expect(mappingSignals).toHaveLength(2));

    const row = (name: string): ResourceReviewRow => ({ virtualPath: `inbox/${name}.pdf`, localPath: `/local/${name}.pdf`, state: 'pending', present: true, sizeBytes: null, fingerprints: [], uses: [], capabilities: { ignore: true, unignore: false, release: false, fingerprint: false, rematchTarget: false, rematchCandidate: true } });
    await act(async () => mappings[1].resolve({ ok: true, json: async () => ({ revision: 'new', rows: [row('new')] }) } as unknown as Response));
    expect(await screen.findByText('inbox/new.pdf')).toBeTruthy();
    await act(async () => mappings[0].resolve({ ok: true, json: async () => ({ revision: 'old', rows: [row('old')] }) } as unknown as Response));

    expect(mappingSignals[0].aborted).toBe(true);
    expect(screen.getByText('inbox/new.pdf')).toBeTruthy();
    expect(screen.queryByText('inbox/old.pdf')).toBeNull();
  });

  it('aborts an in-flight opening load on close and ignores its eventual response', async () => {
    const mapping = deferred<Response>();
    let mappingSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/resources/reconcile')) {
        mappingSignal = init?.signal as AbortSignal;
        return mapping.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const props = { title: 'Attachments', selected: [] as string[], onConfirm: vi.fn(), onClose: vi.fn() };
    const view = render(<LanguageProvider><ResourcePickerDialog open {...props} /></LanguageProvider>);
    await waitFor(() => expect(mappingSignal).toBeDefined());
    view.rerender(<LanguageProvider><ResourcePickerDialog open={false} {...props} /></LanguageProvider>);
    expect(mappingSignal?.aborted).toBe(true);

    await act(async () => mapping.resolve({ ok: true, json: async () => ({ revision: 'late', rows: [{ virtualPath: 'inbox/late.pdf', localPath: '/local/late.pdf', state: 'pending', present: true, sizeBytes: null, fingerprints: [], uses: [], capabilities: { ignore: true, unignore: false, release: false, fingerprint: false, rematchTarget: false, rematchCandidate: true } }] }) } as unknown as Response));
    expect(screen.queryByText('inbox/late.pdf')).toBeNull();
  });

  it('does not let an ignore completion from an old opening mutate a reopened picker', async () => {
    const ignored = deferred<Response>();
    let reconcileCalls = 0;
    let reviewCalls = 0;
    const oldRow = reviewRow('inbox/old.pdf', '/local/old.pdf', { state: 'pending', capabilities: { ...noCapabilities, ignore: true, rematchCandidate: true } });
    const newRow = reviewRow('objects/new.pdf', '/local/new.pdf');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/resources/reconcile')) {
        reconcileCalls += 1;
        const rows = reconcileCalls === 1 ? [oldRow] : [newRow];
        return { ok: true, json: async () => ({ revision: `"v${reconcileCalls}"`, rows }) } as Response;
      }
      if (url.includes('/api/resources/ignore')) return ignored.promise;
      if (url.includes('/api/resources/review')) {
        reviewCalls += 1;
        return { ok: true, json: async () => ({ revision: '"review"', rows: [] }) } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const props = { title: 'Attachments', selected: [] as string[], onConfirm: vi.fn(), onClose: vi.fn() };
    const view = render(<LanguageProvider><ResourcePickerDialog open {...props} /></LanguageProvider>);
    fireEvent.click(await screen.findByText('inbox/old.pdf'));
    fireEvent.click(screen.getByRole('button', { name: 'Ignore Resource' }));

    view.rerender(<LanguageProvider><ResourcePickerDialog open={false} {...props} /></LanguageProvider>);
    view.rerender(<LanguageProvider><ResourcePickerDialog open {...props} /></LanguageProvider>);
    fireEvent.click(await screen.findByText('objects/new.pdf'));
    const confirm = screen.getByRole('button', { name: 'Select Resource' });
    expect(confirm.hasAttribute('disabled')).toBe(false);

    await act(async () => ignored.resolve({ ok: true, json: async () => ({ ignored: ['ignore/old.pdf'], count: 1, revision: '"old"' }) } as Response));
    expect(confirm.hasAttribute('disabled')).toBe(false);
    expect(reviewCalls).toBe(0);
  });

  it('keeps the temporary selection and inventory when the language changes', async () => {
    localStorage.setItem('flightarchive.ui.language', 'en');
    mockBackend(MIXED_ENTRIES);
    const fetchMock = vi.mocked(fetch);
    render(
      <LanguageProvider>
        <LanguageToggle />
        <ResourcePickerDialog open title="Attachments" selected={[]} onConfirm={vi.fn()} onClose={vi.fn()} />
      </LanguageProvider>,
    );
    await screen.findByText('inbox/scan.pdf');
    fireEvent.click(screen.getByText('inbox/scan.pdf'));
    const requestCount = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByText('toggle language'));

    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
    expect(screen.getByTestId('CheckCircleIcon')).toBeTruthy();
  });
});
