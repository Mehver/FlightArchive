// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FlightRecord } from '../api/types';
import { LanguageProvider } from '../i18n';
import { FlightGridView } from './FlightGridView';

afterEach(cleanup);

const FLIGHT: FlightRecord = {
  id: 'f-1',
  flightNumber: '1234',
  airlineCode: 'CA',
  departureAirport: 'PEK',
  arrivalAirport: 'SHA',
  departureTerminal: null,
  arrivalTerminal: null,
  departureDate: '2026-08-01',
  departureTime: null,
  arrivalTime: null,
  aircraftTypeIcao: null,
  registration: null,
  seat: null,
  notes: '',
  createdAt: '2026-08-01T00:00:00',
  updatedAt: '2026-08-01T00:00:00',
  paperBoardingPassFrontResourcePath: null,
  paperBoardingPassBackResourcePath: null,
  electronicBoardingPassResourcePath: null,
  attachmentResourcePaths: [],
  boardingPassColor: '#D32F2F',
};

describe('FlightGridView route presentation', () => {
  it('uses the shared neutral route decoration despite flight theme colours', () => {
    render(
      <LanguageProvider>
        <FlightGridView flights={[FLIGHT]} airlineNames={new Map()} onOpen={() => undefined} />
      </LanguageProvider>,
    );

    expect(screen.getAllByTestId('route-connector')).toHaveLength(1);
  });
});
