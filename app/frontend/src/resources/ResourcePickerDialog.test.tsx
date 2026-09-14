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
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MappingDocument } from '../rfg/api';
import { LanguageProvider } from '../i18n';
import { ResourcePickerDialog } from './ResourcePickerDialog';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const SELECTED: string[] = [];
const IMAGE_PATH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pass.png';

function mockBackend(
  entries: MappingDocument['entries'],
  { flights = [], airlines = [], localFiles = entries.map((entry) => ({ local_path: entry.local_path })) }: {
    flights?: unknown[]; airlines?: unknown[]; localFiles?: { local_path: string }[];
  } = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/resources/ignore')) {
        const ignored = entries.map((entry) => entry.virtual_path.startsWith('inbox/') ? { ...entry, virtual_path: `ignore/${entry.local_path}` } : entry);
        return { ok: true, json: async () => ({ ignoredVirtualPath: ignored[0].virtual_path, mapping: { entries: ignored }, localFiles, etag: '"v2"' }) } as unknown as Response;
      }
      if (url.includes('/api/resources/sync')) {
        return { ok: true, json: async () => ({ cataloged: entries.length, added: 0 }) } as unknown as Response;
      }
      if (url.includes('/api/v1/meta/map')) {
        return { ok: true, json: async () => ({ entries }), headers: { get: () => null } } as unknown as Response;
      }
      if (url.includes('/api/resources/catalog')) {
        return { ok: true, json: async () => ({ localFiles }) } as unknown as Response;
      }
      if (url.includes('/api/flights')) {
        return { ok: true, json: async () => ({ flights }) } as unknown as Response;
      }
      if (url.includes('/api/catalogs')) {
        return { ok: true, json: async () => ({ airlines, airports: [], aircraftTypes: [] }) } as unknown as Response;
      }
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
  { virtual_path: 'inbox/scan.pdf', local_path: '/local/scan.pdf' },
  { virtual_path: 'objects/notes.txt', local_path: '/local/notes.txt' },
  { virtual_path: IMAGE_PATH, local_path: '/local/pass.png' },
];
const IN_USE_PATH = 'objects/shared.png';
const IN_USE_ENTRIES = [{ virtual_path: IN_USE_PATH, local_path: '/local/shared.png' }];
const IN_USE_CONTEXT = {
  flights: [{ id: 'f1', airlineCode: 'SF', flightNumber: '12', departureDate: '2026-01-02', paperBoardingPassFrontResourcePath: IN_USE_PATH, attachmentResourcePaths: [IN_USE_PATH] }],
  airlines: [{ code: 'SF', horizontalLogoResourcePath: IN_USE_PATH, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: IN_USE_PATH }],
};

describe('ResourcePickerDialog thumbnail view', () => {
  it('ignores a selected inbox file and removes it from the selectable list', async () => {
    mockBackend([{ virtual_path: 'inbox/scan.pdf', local_path: '/local/scan.pdf' }]);
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
    mockBackend(IN_USE_ENTRIES, IN_USE_CONTEXT);
    const { onConfirm } = renderPicker();
    await screen.findByText(IN_USE_PATH);

    expect(screen.getByText('Mapped · in use')).toBeTruthy();
    expect(screen.getByText('1 flight(s) · 1 airline(s)')).toBeTruthy();
    fireEvent.mouseOver(screen.getByText('1 flight(s) · 1 airline(s)'));
    expect(await screen.findByText('SF12 · 2026-01-02 · Paper front')).toBeTruthy();
    expect(await screen.findByText('SF12 · 2026-01-02 · Attachment')).toBeTruthy();
    expect(screen.getByText('SF · Horizontal logo')).toBeTruthy();
    expect(screen.getByText('SF · Symbol logo')).toBeTruthy();
    fireEvent.click(screen.getByText(IN_USE_PATH));
    fireEvent.click(screen.getByRole('button', { name: /select resource/i }));
    expect(onConfirm).toHaveBeenCalledWith([IN_USE_PATH]);
  });

  it('shows missing mappings as unavailable without loading their thumbnail or allowing a new selection', async () => {
    const missing = { virtual_path: 'objects/lost.png', local_path: '/local/lost.png' };
    mockBackend([missing], { localFiles: [] });
    const { onConfirm } = renderPicker();
    await screen.findByText(missing.virtual_path);

    expect(screen.getByText(/file unavailable/i)).toBeTruthy();
    expect(document.querySelectorAll('img')).toHaveLength(0);
    const card = screen.getByRole('button', { name: new RegExp(missing.virtual_path) });
    expect(card.hasAttribute('disabled')).toBe(true);
    fireEvent.click(card);
    expect(screen.getByRole('button', { name: /select resource/i }).hasAttribute('disabled')).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
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
    mockBackend(IN_USE_ENTRIES, IN_USE_CONTEXT);
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
    const missing = { virtual_path: 'inbox/stale.pdf', local_path: '/local/stale.pdf' };
    mockBackend([missing], { localFiles: [] });
    const { onConfirm } = renderPicker({ selected: [missing.virtual_path] });
    await screen.findByText('No Entries Found');
    expect(screen.queryByText(missing.virtual_path)).toBeNull();
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
      virtual_path: `inbox/file-${String(index).padStart(2, '0')}.pdf`,
      local_path: `/local/file-${index}.pdf`,
    }));
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
