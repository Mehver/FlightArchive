// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause
// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../i18n';
import { HASH_ALGORITHMS, type MappingEntry } from '../rfg/api';
import type { FingerprintTarget } from './fingerprints';
import { FingerprintDialog } from './FingerprintDialog';

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
        error={null}
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
  fireEvent.click(screen.getByRole('button', { name: 'Queue Calculation' }));
  expect(onCalculate).toHaveBeenCalledWith(['objects/missing.png'], [...HASH_ALGORITHMS], false);
});

it('recalculates every target when force overwrite is selected', () => {
  const onCalculate = dialog();
  fireEvent.click(screen.getByRole('checkbox', { name: /force recalculation/i }));
  expect(screen.getByText(/all 2 selected resource/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Queue Calculation' }));
  expect(onCalculate).toHaveBeenCalledWith(['objects/stored.png', 'objects/missing.png'], [...HASH_ALGORITHMS], true);
});
