// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { isHorizontallyOverflowing, MarqueeCopyText } from './MarqueeCopyText';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('detects horizontal overflow without treating an exact fit as overflow', () => {
  expect(isHorizontallyOverflowing(201, 200)).toBe(true);
  expect(isHorizontallyOverflowing(200, 200)).toBe(false);
});

it('keeps search highlighting and copies the complete value rather than the formatted display', async () => {
  const writeText = vi.fn(async () => undefined);
  const onCopied = vi.fn();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<MarqueeCopyText value="objects/folder/file.png" displayText="file.png" query="file" copiedLabel="Copied" ariaLabel="Copy resource path" onCopied={onCopied} />);

  expect(document.querySelector('mark')?.textContent).toBe('file');
  fireEvent.click(screen.getByRole('button', { name: 'Copy resource path' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('objects/folder/file.png'));
  expect(onCopied).toHaveBeenCalledWith('objects/folder/file.png');
  expect(screen.getByText('Copied')).toBeTruthy();
});
