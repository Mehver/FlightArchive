// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, test } from 'vitest';
import {
  buildFlightVisualTheme,
  getContrastRatio,
  getReadableTextColor,
  hexToCss,
  hexToRgb,
  isValidHexColor,
  lerpColor,
  rgbToHex,
} from './colors';

describe('HexColor utilities', () => {
  test('isValidHexColor accepts valid hex strings', () => {
    expect(isValidHexColor('#000000')).toBe(true);
    expect(isValidHexColor('#FFFFFF')).toBe(true);
    expect(isValidHexColor('#E60012')).toBe(true);
  });

  test('isValidHexColor rejects invalid values', () => {
    expect(isValidHexColor('#fff')).toBe(false);
    expect(isValidHexColor('#gggggg')).toBe(false);
    expect(isValidHexColor('#ffffff')).toBe(false); // lowercase
    expect(isValidHexColor('E60012')).toBe(false); // missing #
    expect(isValidHexColor(null)).toBe(false);
    expect(isValidHexColor({ r: 0, g: 0, b: 0 })).toBe(false);
  });

  test('hexToRgb parses hex correctly', () => {
    expect(hexToRgb('#FF0800')).toEqual({ r: 255, g: 8, b: 0 });
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  test('rgbToHex formats zero-padded uppercase channels', () => {
    expect(rgbToHex({ r: 255, g: 8, b: 0 })).toBe('#FF0800');
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
  });

  test('hexToCss formats as rgb(...) string', () => {
    expect(hexToCss('#FF8000')).toBe('rgb(255, 128, 0)');
  });

  test('getContrastRatio calculates WCAG ratio', () => {
    expect(getContrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });

  test('getReadableTextColor suggests correct text color', () => {
    expect(getReadableTextColor('#000000')).toBe('light');
    expect(getReadableTextColor('#FFFFFF')).toBe('dark');
  });

  test('interpolates and clamps colours to valid sRGB channels', () => {
    expect(lerpColor('#000A14', '#FF1428', 0.5)).toBe('#800F1E');
  });

  test('retains the single flight color ahead of airline fallback colors', () => {
    const airline = {
      code: 'CA', icao: '', nameZh: '', nameEn: '', alliance: null,
      horizontalLogoResourcePath: null, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: null,
      brandColors: { primary: '#010203' as const, contrast: '#040506' as const },
    };
    expect(buildFlightVisualTheme(airline, { boardingPassColor: '#E60012' })).toMatchObject({
      flightColor: '#E60012', airlinePrimary: '#010203', airlineContrast: '#040506',
    });
    expect(buildFlightVisualTheme(airline, { boardingPassColor: null }).flightColor).toBeNull();
  });

});
