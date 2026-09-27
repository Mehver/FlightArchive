// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ResourceReviewRow } from '../api/types';
import { LanguageProvider } from '../i18n';
import { ResourceBrowser } from './ResourceBrowser';
import { useResourceBrowser, type ResourceBrowserFilter, type ResourceBrowserOrder } from './useResourceBrowser';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const capabilities = { ignore: false, unignore: false, release: true, fingerprint: false, rematchTarget: false, rematchCandidate: false };
const rows: ResourceReviewRow[] = [
  { virtualPath: 'objects/a.pdf', localPath: '/a.pdf', state: 'mapped', present: true, sizeBytes: null, fingerprints: [], uses: [], capabilities },
  { virtualPath: 'inbox/z.pdf', localPath: '/z.pdf', state: 'pending', present: true, sizeBytes: null, fingerprints: [], uses: [], capabilities: { ...capabilities, ignore: true } },
  { virtualPath: 'objects/image.png', localPath: '/image.png', state: 'mapped', present: true, sizeBytes: null, fingerprints: [], uses: [], capabilities },
];

function mockReview() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ revision: 'v1', rows }) }) as Response));
}

const pdfOnly: ResourceBrowserFilter = ({ entry }) => entry.virtual_path.endsWith('.pdf');
const pathDescending: ResourceBrowserOrder = (left, right) => right.entry.virtual_path.localeCompare(left.entry.virtual_path);

describe('useResourceBrowser', () => {
  it('applies caller filters and ordering while owning paging and selection', async () => {
    mockReview();
    const { result } = renderHook(() => useResourceBrowser({ active: true, multiple: true, filter: pdfOnly, order: pathDescending }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.visible.map((item) => item.entry.virtual_path)).toEqual(['objects/a.pdf', 'inbox/z.pdf']);

    result.current.toggle('objects/a.pdf');
    await waitFor(() => expect(result.current.picked).toEqual(['objects/a.pdf']));
  });
});

function BrowserHarness() {
  const browser = useResourceBrowser({ active: true, filter: pdfOnly });
  return <ResourceBrowser browser={browser} label="Reusable resources" />;
}

describe('ResourceBrowser', () => {
  it('renders toolbar and interchangeable grid/list representations without a dialog shell', async () => {
    mockReview();
    render(<LanguageProvider><BrowserHarness /></LanguageProvider>);

    expect(await screen.findByText('inbox/z.pdf')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('objects/image.png')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /list view/i }));
    expect(screen.getByRole('table', { name: 'Reusable resources' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search Resources'), { target: { value: 'a.pdf' } });
    expect(screen.getByRole('radio').textContent).toContain('a.pdf');
  });
});
