// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * UI preference for the flight display view mode. Persisted in localStorage
 * under the same `flightarchive.ui.*` convention as the language preference —
 * this is a pure UI preference, never business-data caching.
 */

import { useCallback, useState } from 'react';

export type FlightViewMode = 'list' | 'grid';

export const FLIGHT_VIEW_MODES: readonly FlightViewMode[] = ['list', 'grid'];
export const FLIGHT_VIEW_MODE_STORAGE_KEY = 'flightarchive.ui.flightViewMode';
export const DEFAULT_FLIGHT_VIEW_MODE: FlightViewMode = 'list';

export function parseFlightViewMode(stored: string | null | undefined): FlightViewMode {
  return (FLIGHT_VIEW_MODES as readonly string[]).includes(stored ?? '') ? (stored as FlightViewMode) : DEFAULT_FLIGHT_VIEW_MODE;
}

export function useFlightViewMode(): [FlightViewMode, (mode: FlightViewMode) => void] {
  const [mode, setModeState] = useState<FlightViewMode>(() => {
    try {
      return parseFlightViewMode(localStorage.getItem(FLIGHT_VIEW_MODE_STORAGE_KEY));
    } catch {
      return DEFAULT_FLIGHT_VIEW_MODE;
    }
  });
  const setMode = useCallback((next: FlightViewMode) => {
    setModeState(next);
    try {
      localStorage.setItem(FLIGHT_VIEW_MODE_STORAGE_KEY, next);
    } catch {
      /* storage may be unavailable; the in-memory preference still applies */
    }
  }, []);
  return [mode, setMode];
}
