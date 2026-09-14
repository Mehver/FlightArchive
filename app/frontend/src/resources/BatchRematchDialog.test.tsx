// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../i18n';
import { BatchRematchDialog } from './BatchRematchDialog';

afterEach(cleanup);

const CANDIDATES = [
  { virtual_path: 'inbox/one.png', local_path: 'one.png' },
  { virtual_path: 'inbox/two.png', local_path: 'two.png' },
];

it('selects text-only pending files and identifiers for a batch rematch', () => {
  const apply = vi.fn();
  render(<LanguageProvider><BatchRematchDialog open candidates={[{ virtual_path: 'inbox/new.png', local_path: 'new.png' }]} busy={false} onApply={apply} onClose={() => undefined} /></LanguageProvider>);
  expect(screen.queryByRole('img')).toBeNull();
  fireEvent.click(screen.getByText('new.png'));
  fireEvent.click(screen.getByRole('button', { name: 'Calculate & Reconnect' }));
  expect(apply).toHaveBeenCalledWith(['inbox/new.png'], ['filename', 'sizeBytes']);
});

it('selects and clears all currently visible candidates', () => {
  render(<LanguageProvider><BatchRematchDialog open candidates={CANDIDATES} busy={false} onApply={() => undefined} onClose={() => undefined} /></LanguageProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
  expect(screen.getByText('2 selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear Selection' }));
  expect(screen.getByText('0 selected')).toBeTruthy();
});

it('selects only the filtered candidates and enables the batch action', () => {
  const apply = vi.fn();
  render(<LanguageProvider><BatchRematchDialog open candidates={CANDIDATES} busy={false} onApply={apply} onClose={() => undefined} /></LanguageProvider>);
  fireEvent.change(screen.getByLabelText('Search pending files'), { target: { value: 'two' } });
  expect(screen.queryByText('one.png')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
  expect(screen.getByText('1 selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Calculate & Reconnect' }));
  expect(apply).toHaveBeenCalledWith(['inbox/two.png'], ['filename', 'sizeBytes']);
});
