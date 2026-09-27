// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ResourceReviewRow } from '../api/types';
import { LanguageProvider } from '../i18n';
import { AutoRematchDialog } from './AutoRematchDialog';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const capabilities = { ignore: false, unignore: false, release: false, fingerprint: false, rematchTarget: false, rematchCandidate: false };

it('shows only inbox candidates, carries preselection, and submits candidates, fixed targets, and fields', async () => {
  const rows: ResourceReviewRow[] = [
    { virtualPath: 'inbox/new.png', localPath: '/new.png', state: 'pending', present: true, sizeBytes: 1, fingerprints: [], uses: [], capabilities: { ...capabilities, ignore: true, rematchCandidate: true } },
    { virtualPath: 'objects/live.png', localPath: '/live.png', state: 'mapped', present: true, sizeBytes: 1, fingerprints: [], uses: [], capabilities },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ revision: 'v1', rows }) }) as Response));
  const apply = vi.fn();
  render(<LanguageProvider><AutoRematchDialog open targetPaths={['objects/missing.png']} initialCandidatePaths={['inbox/new.png']} busy={false} onApply={apply} onClose={vi.fn()} /></LanguageProvider>);

  const dialog = await screen.findByRole('dialog', { name: 'Auto-rematch' });
  expect(within(dialog).getByText('inbox/new.png')).toBeTruthy();
  expect(within(dialog).queryByText('objects/live.png')).toBeNull();
  expect(within(dialog).getByText('objects/missing.png')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rematch' }));
  expect(apply).toHaveBeenCalledWith(['inbox/new.png'], ['objects/missing.png'], ['filename', 'sizeBytes']);
});
