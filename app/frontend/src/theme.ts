// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { createTheme } from '@mui/material/styles';
import type { HexColor } from './api/types';

declare module '@mui/material/styles' {
  interface Palette {
    productAccent: ProductAccentPalette;
  }

  interface PaletteOptions {
    productAccent?: ProductAccentPalette;
  }
}

interface ProductAccentPalette {
  /** Fixed product identity colour, independent of the current colour scheme. */
  main: HexColor;
}

export const PRODUCT_ACCENT_BLUE: HexColor = '#64B3F4';

export function buildTheme(mode: 'light' | 'dark') {
  return createTheme({
    palette: {
      mode,
      primary: { main: mode === 'light' ? '#1565c0' : '#64b5f6' },
      secondary: { main: mode === 'light' ? '#00838f' : '#4dd0e1' },
      // Product accents are distinct from semantic success, warning, and error colours.
      // Keep the identity blue fixed so status/action controls are recognisable in either mode.
      productAccent: {
        main: PRODUCT_ACCENT_BLUE,
      },
      // The default light divider is too faint for the thin rules used across
      // flight cards. One restrained contrast step improves legibility while
      // retaining the standard dark-mode value.
      divider: mode === 'light' ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.12)',
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily:
        '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif',
      h6: { fontWeight: 650 },
    },
    components: {
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiCssBaseline: {
        styleOverrides: {
          'input[type="date"], input[type="time"]': {
            colorScheme: mode,
          },
          'input[type="date"]::-webkit-calendar-picker-indicator, input[type="time"]::-webkit-calendar-picker-indicator': {
            filter: mode === 'dark' ? 'brightness(0) invert(1)' : 'brightness(0)',
            opacity: 1,
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          head: { fontWeight: 650 },
        },
      },
    },
  });
}
