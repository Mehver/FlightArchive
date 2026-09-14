// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Shared presentational primitives for the flight display views (list and
 * card grid): route typography,
 * airline name lookup, and the keyboard-accessible "clickable record"
 * interaction. Keeping them here stops the individual views from drifting
 * apart visually.
 */

import type { KeyboardEvent } from 'react';
import { Box } from '@mui/material';
import FlightIcon from '@mui/icons-material/Flight';
import type { Airline, Airport, Catalogs, FlightRecord } from '../api/types';
import { displayName, unlistedCodeLabel } from '../utils/format';

/** Props shared by every archive view: the same filtered API results plus
 *  the record interactions. Edit/delete are optional so read-only contexts
 *  can reuse the views without actions. */
export interface FlightViewProps {
  flights: FlightRecord[];
  airlineNames: Map<string, string>;
  /** Optional airport catalogue used by richer card views. */
  airports?: Map<string, Airport>;
  /** Optional catalog records used by richer views for airline artwork. */
  airlines?: Map<string, Airline>;
  onOpen: (flight: FlightRecord) => void;
  onEdit?: (flight: FlightRecord) => void;
  onDelete?: (flight: FlightRecord) => void;
  /** Accessible label for the open interaction; defaults to the flight-detail
   *  label. */
  openLabel?: (flightNumber: string) => string;
}

export function buildAirlineNames(catalogs: Catalogs | null, notAvailable: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const airline of catalogs?.airlines ?? []) map.set(airline.code, displayName(airline.nameZh, airline.nameEn, notAvailable));
  return map;
}

export function buildAirlines(catalogs: Catalogs | null): Map<string, Airline> {
  return new Map((catalogs?.airlines ?? []).map((airline) => [airline.code, airline]));
}

export function buildAirports(catalogs: Catalogs | null): Map<string, Airport> {
  return new Map((catalogs?.airports ?? []).map((airport) => [airport.code, airport]));
}

/** Airline caption where a catalogued name is expected: the catalogued
 *  bilingual name, or — for a valid but uncatalogued code — the stored code
 *  plus the bilingual "unlisted reference" note (never blank, never just
 *  the bare code). */
export function airlineLabel(code: string, airlineNames: Map<string, string>): string {
  return airlineNames.get(code) ?? (code ? unlistedCodeLabel(code) : code);
}

/** Keyboard/mouse interaction contract for a clickable flight record:
 *  Enter/Space open the detail, explicit edit/delete controls inside stop
 *  propagation so they never accidentally open it. */
export function clickableRecordProps(onOpen: () => void, ariaLabel: string) {
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': ariaLabel,
    onClick: onOpen,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen();
      }
    },
  } as const;
}

/** Shared route connector used wherever a flight's two endpoints are shown.
 * The icon deliberately follows the card's normal body text rather than its
 * airline/flight colour wash; the neutral divider token also keeps both dashes
 * aligned with detail-sheet separators. */
export const routeConnectorLineSx = {
  flex: 1,
  borderTop: '2px dashed',
  borderColor: 'divider',
} as const;

export function RouteConnector({
  sx,
  iconSize = 20,
  iconMargin = 0.5,
}: {
  sx?: object;
  iconSize?: number | { xs: number; sm: number };
  iconMargin?: number;
}) {
  return (
    <Box
      aria-hidden
      data-testid="route-connector"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        color: 'text.primary',
        minWidth: 24,
        ...sx,
      }}
    >
      <Box sx={routeConnectorLineSx} />
      <FlightIcon sx={{ fontSize: iconSize, transform: 'rotate(90deg)', mx: iconMargin }} />
      <Box sx={routeConnectorLineSx} />
    </Box>
  );
}
