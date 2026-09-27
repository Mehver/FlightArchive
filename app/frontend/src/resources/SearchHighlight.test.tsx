// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause
// @vitest-environment jsdom

import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SearchHighlight } from './SearchHighlight';

afterEach(cleanup);

it('keeps source offsets correct when case folding changes string length', () => {
  const { container } = render(<SearchHighlight text="İx" query="x" />);
  expect(container.textContent).toBe('İx');
  expect(container.querySelector('mark')?.textContent).toBe('x');
});
