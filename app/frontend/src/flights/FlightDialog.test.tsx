// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Airport, Catalogs, FlightRecord } from '../api/types';
import { LanguageProvider } from '../i18n';
import { airportTerminalOptions, FlightDialog, formToPayload } from './FlightDialog';

afterEach(cleanup);

const SCREENSHOT_FLIGHT: FlightRecord = {
  id: 'f-1',
  flightNumber: '001',
  airlineCode: 'CA',
  departureAirport: '',
  arrivalAirport: '',
  departureTerminal: null,
  arrivalTerminal: null,
  departureDate: '2026-08-29',
  departureTime: null,
  arrivalTime: null,
  aircraftTypeIcao: null,
  registration: null,
  seat: null,
  notes: '',
  createdAt: '2026-08-29T00:00:00',
  updatedAt: '2026-08-29T00:00:00',
  paperBoardingPassFrontResourcePath: null,
  paperBoardingPassBackResourcePath: null,
  electronicBoardingPassResourcePath: null,
  attachmentResourcePaths: [],
  boardingPassColor: null,
};

const EMPTY_FORM = {
  flightNumber: '',
  airlineCode: '',
  departureAirport: '',
  arrivalAirport: '',
  departureTerminal: '',
  arrivalTerminal: '',
  departureDate: '',
  departureTime: '',
  arrivalTime: '',
  aircraftTypeIcao: '',
  registration: '',
  seat: '',
  notes: '',
  paperBoardingPassFrontResourcePath: null,
  paperBoardingPassBackResourcePath: null,
  electronicBoardingPassResourcePath: null,
  boardingPassColor: null,
  attachmentResourcePaths: [],
};

const AIRCRAFT_CATALOGS: Catalogs = {
  airlines: [],
  airports: [{ code: 'PEK', icao: 'ZBAA', nameZh: '北京首都', nameEn: 'Beijing Capital', cityZh: '北京', cityEn: 'Beijing', countryZh: '中国', countryEn: 'China', terminals: ['T10', 'T2', 't2'] }],
  aircraftTypes: [
    { icao: 'A3B', iata: '3AB', manufacturer: 'Example', displayName: '示例飞机 / Example Jet' },
    { icao: 'A320', iata: '320', manufacturer: 'Airbus', displayName: 'Airbus A320' },
  ],
};

const TERMINAL_AIRPORTS: Airport[] = [
  { code: 'PEK', icao: 'ZBAA', nameZh: '', nameEn: 'Beijing Capital', cityZh: '', cityEn: '', countryZh: '', countryEn: '', terminals: ['T10', 'T2', 't2'] },
];

describe('formToPayload', () => {
  it('deduplicates and caps attachmentResourcePaths at 32', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `path/${i}`);
    paths[1] = 'path/0'; // duplicate
    const payload = formToPayload({ ...EMPTY_FORM, attachmentResourcePaths: paths });
    expect(payload.attachmentResourcePaths).toHaveLength(32);
    expect(payload.attachmentResourcePaths![0]).toBe('path/0');
    expect(new Set(payload.attachmentResourcePaths).size).toBe(32);
  });
});

describe('FlightDialog submission validation', () => {
  it('shows one boarding-pass color input', () => {
    render(
      <LanguageProvider>
        <FlightDialog open initial={null} catalogs={null} saving={false} onSave={vi.fn()} onClose={() => undefined} />
      </LanguageProvider>,
    );
    expect(screen.getByLabelText('Boarding Pass Color')).toBeTruthy();
    expect(screen.queryByLabelText('Boarding Pass Primary Color')).toBeNull();
    expect(screen.queryByLabelText('Boarding Pass Contrast Color')).toBeNull();
  });

  it('does not save the screenshot state and highlights both missing airports', () => {
    const onSave = vi.fn();
    render(
      <LanguageProvider>
        <FlightDialog
          open
          initial={SCREENSHOT_FLIGHT}
          catalogs={null}
          saving={false}
          onSave={onSave}
          onClose={() => undefined}
        />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Origin Airport' }).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('combobox', { name: 'Destination Airport' }).getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText('This field is required')).toBeNull();
  });

  it('submits flight data without the retired status attribute', () => {
    const payload = formToPayload({
      flightNumber: '123', airlineCode: 'ca', departureAirport: 'pek', arrivalAirport: 'sha',
      departureTerminal: '', arrivalTerminal: '', departureDate: '2026-08-29', departureTime: '', arrivalTime: '',
      aircraftTypeIcao: '', registration: '', seat: '', notes: '',
      paperBoardingPassFrontResourcePath: null, paperBoardingPassBackResourcePath: null,
      electronicBoardingPassResourcePath: null, boardingPassColor: null,
      attachmentResourcePaths: [],
    });
    expect(payload).not.toHaveProperty('status');
  });

  it('normalizes an unlisted aircraft type designator to uppercase on submission', () => {
    const payload = formToPayload({
      ...EMPTY_FORM,
      flightNumber: '123', airlineCode: 'ca', departureAirport: 'pek', arrivalAirport: 'sha', departureDate: '2026-08-29',
      aircraftTypeIcao: 'a3b',
    });
    expect(payload.aircraftTypeIcao).toBe('A3B');
  });

  it('normalizes a trimmed international registration on submission', () => {
    const payload = formToPayload({ ...EMPTY_FORM, registration: ' g-abcd ' });
    expect(payload.registration).toBe('G-ABCD');
  });

  it('uses the hyphen-free placeholder and gives immediate registration-format feedback', () => {
    render(
      <LanguageProvider>
        <FlightDialog open initial={null} catalogs={null} saving={false} onSave={vi.fn()} onClose={() => undefined} />
      </LanguageProvider>,
    );
    const registration = screen.getByRole('textbox', { name: 'Registration' }) as HTMLInputElement;
    expect(registration.placeholder).toBe('B1234');
    fireEvent.change(registration, { target: { value: 'n--123' } });
    expect(registration.value).toBe('N--123');
    expect(registration.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText('2–16 letters or digits; hyphens only between characters')).toBeNull();
  });

  it('disables terminals until their airport is entered while retaining their labels', () => {
    render(
      <LanguageProvider>
        <FlightDialog open initial={null} catalogs={AIRCRAFT_CATALOGS} saving={false} onSave={vi.fn()} onClose={() => undefined} />
      </LanguageProvider>,
    );
    expect((screen.getByRole('combobox', { name: 'Departure Terminal' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: 'Arrival Terminal' }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText('Enter an airport code first')).toBeNull();
  });

  it('derives naturally sorted, deduplicated terminal suggestions only for the selected airport', () => {
    expect(airportTerminalOptions(TERMINAL_AIRPORTS, 'PEK', 'en')).toEqual(['T2', 'T10']);
    expect(airportTerminalOptions(TERMINAL_AIRPORTS, 'XYZ', 'en')).toEqual([]);
  });

  it('disables terminals for an unlisted airport and clears them when the airport changes', () => {
    render(
      <LanguageProvider>
        <FlightDialog open initial={null} catalogs={AIRCRAFT_CATALOGS} saving={false} onSave={vi.fn()} onClose={() => undefined} />
      </LanguageProvider>,
    );
    const airport = screen.getByRole('combobox', { name: 'Origin Airport' }) as HTMLInputElement;
    const terminal = screen.getByRole('combobox', { name: 'Departure Terminal' }) as HTMLInputElement;
    fireEvent.change(airport, { target: { value: 'xyz' } });
    expect(airport.value).toBe('XYZ');
    expect(terminal.disabled).toBe(true);
    fireEvent.change(airport, { target: { value: 'pek' } });
    expect(airport.value).toBe('PEK');
    expect(terminal.value).toBe('');
  });

  it('displays a legacy terminal outside the current catalog without making it a new option', () => {
    render(<LanguageProvider><FlightDialog open initial={{ ...SCREENSHOT_FLIGHT, departureAirport: 'PEK', arrivalAirport: 'PEK', departureTerminal: 'Legacy Pier' }} catalogs={AIRCRAFT_CATALOGS} saving={false} onSave={vi.fn()} onClose={() => undefined} /></LanguageProvider>);
    const terminal = screen.getByRole('combobox', { name: 'Departure Terminal' }) as HTMLInputElement;
    expect(terminal.disabled).toBe(false);
    expect(terminal.value).toBe('Legacy Pier');
    fireEvent.mouseDown(terminal);
    expect(screen.queryByRole('option', { name: 'Legacy Pier' })).toBeNull();
  });

  it('preserves a legacy terminal when an otherwise valid flight is saved', () => {
    const onSave = vi.fn();
    render(
      <LanguageProvider>
        <FlightDialog
          open
          initial={{ ...SCREENSHOT_FLIGHT, departureAirport: 'PEK', arrivalAirport: 'SHA', departureTerminal: 'Legacy Pier' }}
          catalogs={AIRCRAFT_CATALOGS}
          saving={false}
          onSave={onSave}
          onClose={() => undefined}
        />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      departureAirport: 'PEK',
      departureTerminal: 'Legacy Pier',
    }));
  });

  it('filters catalog aircraft options and stores the selected ICAO designator', async () => {
    render(
      <LanguageProvider>
        <FlightDialog
          open
          initial={null}
          catalogs={AIRCRAFT_CATALOGS}
          saving={false}
          onSave={vi.fn()}
          onClose={() => undefined}
        />
      </LanguageProvider>,
    );

    const input = screen.getByRole('combobox', { name: 'Aircraft Type' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a3' } });

    expect(input.value).toBe('A3');
    const option = await screen.findByRole('option', { name: 'A3B · 3AB — 示例飞机 / Example Jet' });
    fireEvent.click(option);

    expect(input.value).toBe('A3B');
  });

  it('keeps an existing or unlisted aircraft type as the editable ICAO value', () => {
    const { rerender } = render(
      <LanguageProvider>
        <FlightDialog open initial={{ ...SCREENSHOT_FLIGHT, aircraftTypeIcao: 'A3B' }} catalogs={AIRCRAFT_CATALOGS} saving={false} onSave={vi.fn()} onClose={() => undefined} />
      </LanguageProvider>,
    );
    expect((screen.getByRole('combobox', { name: 'Aircraft Type' }) as HTMLInputElement).value).toBe('A3B');

    rerender(
      <LanguageProvider>
        <FlightDialog open initial={{ ...SCREENSHOT_FLIGHT, aircraftTypeIcao: 'ZZ' }} catalogs={null} saving={false} onSave={vi.fn()} onClose={() => undefined} />
      </LanguageProvider>,
    );
    expect((screen.getByRole('combobox', { name: 'Aircraft Type' }) as HTMLInputElement).value).toBe('ZZ');
  });
});
