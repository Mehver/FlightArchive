// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Characterization of the flight display view-mode UI preference parsing. */

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLIGHT_VIEW_MODE, FLIGHT_VIEW_MODES, parseFlightViewMode } from './flightViewPreference';

describe('parseFlightViewMode', () => {
  it('accepts only the list and card-grid display choices', () => {
    for (const mode of FLIGHT_VIEW_MODES) {
      expect(parseFlightViewMode(mode)).toBe(mode);
    }
  });

  it('migrates the removed timeline preference and falls back for invalid values', () => {
    expect(parseFlightViewMode(null)).toBe(DEFAULT_FLIGHT_VIEW_MODE);
    expect(parseFlightViewMode(undefined)).toBe(DEFAULT_FLIGHT_VIEW_MODE);
    expect(parseFlightViewMode('')).toBe(DEFAULT_FLIGHT_VIEW_MODE);
    expect(parseFlightViewMode('table')).toBe(DEFAULT_FLIGHT_VIEW_MODE);
    expect(parseFlightViewMode('timeline')).toBe(DEFAULT_FLIGHT_VIEW_MODE);
    expect(parseFlightViewMode('GRID')).toBe(DEFAULT_FLIGHT_VIEW_MODE);
  });
});
