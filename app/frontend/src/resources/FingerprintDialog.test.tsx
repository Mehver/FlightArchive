// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause
// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../i18n';
import { HASH_ALGORITHMS, type MappingEntry } from '../rfg/api';
import type { FingerprintTarget } from './fingerprints';
import { FingerprintDialog } from './FingerprintDialog';

beforeEach(() => localStorage.setItem('flightarchive.ui.language', 'en'));
afterEach(cleanup);

function target(path: string, stored: readonly (typeof HASH_ALGORITHMS)[number][]): FingerprintTarget {
  const entry: MappingEntry = { virtual_path: path, local_path: `/${path}` };
  for (const algorithm of stored) entry[algorithm] = `${algorithm}-value`;
  return { virtualPath: path, localPath: `/${path}`, entry, stored, supported: HASH_ALGORITHMS };
}

function dialog(onCalculate = vi.fn()) {
  render(
    <LanguageProvider>
      <FingerprintDialog
        open
        targets={[target('objects/stored.png', HASH_ALGORITHMS), target('objects/missing.png', [])]}
        busy={false}
        onCalculate={onCalculate}
        onClose={vi.fn()}
      />
    </LanguageProvider>,
  );
  return onCalculate;
}

it('skips targets that already store all selected algorithms by default', () => {
  const onCalculate = dialog();
  expect(screen.getByText(/1 resource\(s\) missing/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Calculate Fingerprints' }));
  expect(onCalculate).toHaveBeenCalledWith(['objects/missing.png'], [...HASH_ALGORITHMS], false);
});

it('recalculates every target when force overwrite is selected', () => {
  const onCalculate = dialog();
  fireEvent.click(screen.getByRole('checkbox', { name: /force recalculation/i }));
  expect(screen.getByText(/all 2 selected resource/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Calculate Fingerprints' }));
  expect(onCalculate).toHaveBeenCalledWith(['objects/stored.png', 'objects/missing.png'], [...HASH_ALGORITHMS], true);
});

it('describes direct mapped-resource calculation without task or ownership claims', () => {
  dialog();
  expect(screen.getByText(/mapped resources whose source files are present/i)).toBeTruthy();
  expect(screen.getByText(/current session/i)).toBeTruthy();
  expect(screen.queryByText(/saved flights|airline logos|tasks/i)).toBeNull();
});

it('localizes current-session progress in English and Chinese', () => {
  const renderBusy = () => render(
    <LanguageProvider>
      <FingerprintDialog open targets={[target('objects/a.png', [])]} busy progress={{ completed: 3, total: 5, succeeded: 2, failed: 1 }} onCalculate={vi.fn()} onClose={vi.fn()} />
    </LanguageProvider>,
  );
  const english = renderBusy();
  expect(screen.getByText('3/5 · 2 Succeeded · 1 Failed')).toBeTruthy();
  english.unmount();
  localStorage.setItem('flightarchive.ui.language', 'zh-CN');
  renderBusy();
  expect(screen.getByText('3/5 · 成功 2 个 · 失败 1 个')).toBeTruthy();
  expect(screen.getByRole('button', { name: '正在计算…' })).toBeTruthy();
});
