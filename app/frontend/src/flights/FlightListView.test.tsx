// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Interaction contract of the archive list view: clicking a row opens the
 * flight detail, while the explicit edit/delete controls fire their own
 * actions without accidentally opening the detail.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FlightRecord } from '../api/types';
import { LanguageProvider } from '../i18n';
import { FlightListView } from './FlightListView';

afterEach(cleanup);

const FLIGHT: FlightRecord = {
  id: 'f-1',
  flightNumber: '1234',
  airlineCode: 'CA',
  departureAirport: 'PEK',
  arrivalAirport: 'SHA',
  departureTerminal: 'T3',
  arrivalTerminal: null,
  departureDate: '2026-08-01',
  departureTime: '08:30',
  arrivalTime: '10:45',
  aircraftTypeIcao: 'A321',
  registration: 'B-1234',
  seat: '12A',

  notes: '',
  createdAt: '2026-08-01T00:00:00',
  updatedAt: '2026-08-01T00:00:00',
  paperBoardingPassFrontResourcePath: null,
  paperBoardingPassBackResourcePath: null,
  electronicBoardingPassResourcePath: null,
  attachmentResourcePaths: [],
  boardingPassColor: null,
};

function renderView(props: Partial<Parameters<typeof FlightListView>[0]> = {}) {
  const onOpen = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(
    <LanguageProvider>
      <FlightListView
        flights={[FLIGHT]}
        airlineNames={new Map()}
        onOpen={onOpen}
        onEdit={onEdit}
        onDelete={onDelete}
        {...props}
      />
    </LanguageProvider>,
  );
  return { onOpen, onEdit, onDelete };
}

describe('FlightListView interactions', () => {
  it('uses the shared neutral route decoration in its banner preview', () => {
    renderView();
    expect(screen.getAllByTestId('route-connector')).toHaveLength(1);
  });

  it('pads only a numerical flight-number suffix for aligned banner display', () => {
    renderView({ flights: [{ ...FLIGHT, flightNumber: '1' }] });
    expect(screen.getByText('CA0001')).toBeTruthy();
    expect(screen.getByRole('button', { name: /CA0001/ })).toBeTruthy();
  });

  it('leaves a non-numeric flight-number suffix unchanged', () => {
    renderView({ flights: [{ ...FLIGHT, flightNumber: 'A1B' }] });
    expect(screen.getByText('CAA1B')).toBeTruthy();
  });

  it('keeps airline information and the route preview in separate horizontal groups', () => {
    renderView({ airlineNames: new Map([['CA', 'Air China']]) });

    const infoGroup = screen.getByTestId('flight-list-info-group');
    const routeGroup = screen.getByTestId('flight-list-route-group');
    const connector = screen.getByTestId('route-connector');
    expect(infoGroup.textContent).toContain('Air China');
    expect(infoGroup.contains(connector)).toBe(false);
    expect(routeGroup.contains(connector)).toBe(true);
  });

  it('keeps the flight number and date together while preserving the separate route and paper previews', () => {
    renderView();
    const identifierDate = screen.getByTestId('flight-list-identifier-date');
    expect(identifierDate.textContent).toContain('CA1234');
    expect(identifierDate.textContent).toContain('2026-08-01');
    expect(screen.getByTestId('flight-list-route-preview').contains(screen.getByTestId('route-connector'))).toBe(true);
    expect(screen.getByTestId('flight-list-paper-front-preview')).toBeTruthy();
    expect(screen.getByTestId('flight-list-route-ticket-strip').contains(screen.getByTestId('flight-list-paper-front-preview'))).toBe(true);
    expect(screen.getByTestId('flight-list-route-ticket-strip').contains(screen.getByTestId('flight-list-paper-back-preview'))).toBe(true);
  });

  it('keeps all primary banner text in the left and route groups on one row', () => {
    renderView({ airlineNames: new Map([['CA', 'Air China']]) });
    const infoGroup = screen.getByTestId('flight-list-info-group');
    const routeGroup = screen.getByTestId('flight-list-route-group');
    expect(infoGroup.textContent).toContain('CA1234');
    expect(infoGroup.textContent).toContain('2026-08-01');
    expect(infoGroup.textContent).toContain('Air China');
    expect(routeGroup.textContent).toContain('PEK T3');
    expect(routeGroup.textContent).toContain('SHA');
  });

  it('keeps the compact identifier/date pair and route-ticket strip as grouped spacing units', () => {
    renderView();
    const infoGroup = screen.getByTestId('flight-list-info-group');
    const routeGroup = screen.getByTestId('flight-list-route-group');
    expect(infoGroup.children).toHaveLength(3);
    expect(infoGroup.children[0]).toBe(screen.getByTestId('flight-list-logo-host'));
    expect(infoGroup.children[1]).toBe(screen.getByTestId('flight-list-identifier-date'));
    expect(routeGroup.children[0]).toBe(screen.getByTestId('flight-list-route-ticket-strip'));
  });

  it('opens the flight detail when the row is clicked', () => {
    const { onOpen, onEdit } = renderView();
    fireEvent.click(screen.getByRole('button', { name: /CA1234/ }));
    expect(onOpen).toHaveBeenCalledWith(FLIGHT);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('opens the flight detail via keyboard Enter', () => {
    const { onOpen } = renderView();
    fireEvent.keyDown(screen.getByRole('button', { name: /CA1234/ }), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(FLIGHT);
  });

  it('edits without opening the detail when the edit control is clicked', () => {
    const { onOpen, onEdit } = renderView();
    fireEvent.click(screen.getByRole('button', { name: /Edit flight/i }));
    expect(onEdit).toHaveBeenCalledWith(FLIGHT);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('deletes without opening the detail when the delete control is clicked', () => {
    const { onOpen, onDelete } = renderView();
    fireEvent.click(screen.getByRole('button', { name: /Delete flight/i }));
    expect(onDelete).toHaveBeenCalledWith(FLIGHT);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('hides edit/delete controls in read-only contexts', () => {
    render(
      <LanguageProvider>
        <FlightListView flights={[FLIGHT]} airlineNames={new Map()} onOpen={() => undefined} />
      </LanguageProvider>,
    );
    expect(screen.queryByRole('button', { name: /Edit flight/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete flight/i })).toBeNull();
  });

  it('shows the stored code plus the bilingual unlisted note for an uncatalogued airline', () => {
    renderView({ flights: [{ ...FLIGHT, airlineCode: 'ZZ' }], airlineNames: new Map() });
    expect(screen.getByText('ZZ · 未收录 · Unlisted')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('keeps the catalogued name for a listed airline', () => {
    renderView({ airlineNames: new Map([['CA', '中国国航 · Air China']]) });
    expect(screen.getByText('中国国航 · Air China')).toBeTruthy();
  });
});
