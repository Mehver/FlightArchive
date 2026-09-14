// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, test } from 'vitest';
import { buildTheme, PRODUCT_ACCENT_BLUE } from './theme';

describe('product accent palette', () => {
  test('keeps the product accent blue unchanged in light and dark themes', () => {
    expect(buildTheme('light').palette.productAccent.main).toBe(PRODUCT_ACCENT_BLUE);
    expect(buildTheme('dark').palette.productAccent.main).toBe(PRODUCT_ACCENT_BLUE);
  });

  test('keeps product accent surfaces distinct from semantic status colours', () => {
    const theme = buildTheme('light');

    expect(theme.palette.productAccent.main).not.toBe(theme.palette.success.main);
    expect(theme.palette.productAccent.main).not.toBe(theme.palette.warning.main);
    expect(theme.palette.productAccent.main).not.toBe(theme.palette.error.main);
  });

});
