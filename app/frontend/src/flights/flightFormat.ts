// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Canonical browser-side input formats; the backend remains authoritative. */

export type FlightValidationField =
  | 'flightNumber'
  | 'airlineCode'
  | 'departureAirport'
  | 'arrivalAirport'
  | 'departureDate'
  | 'departureTime'
  | 'arrivalTime'
  | 'aircraftTypeIcao'
  | 'registration';

export type FlightValidationError = 'required' | 'format';

export type FlightValidationErrors = Partial<Record<FlightValidationField, FlightValidationError>>;

/** The directly editable fields whose syntax is also enforced by FlightRecord. */
export interface FlightInputForValidation {
  flightNumber: string;
  airlineCode: string;
  departureAirport: string;
  arrivalAirport: string;
  departureDate: string;
  departureTime: string;
  arrivalTime: string;
  aircraftTypeIcao: string;
  registration: string;
}

export function normalizeFlightNumber(value: string): string {
  return value.replace(/\D/g, '').slice(0, 4);
}

export function normalizeAirlineCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
}

export function normalizeAirportCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export function normalizeAircraftRegistration(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeDate(value: string): string {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function isAirlineCode(value: string): boolean {
  return /^[A-Z0-9]{2,3}$/.test(value);
}

export function isAirportCode(value: string): boolean {
  return /^[A-Z]{3,4}$/.test(value);
}

/** ICAO aircraft type designators are distinct from fixed-width airport and airline ICAO codes. */
export function isAircraftTypeIcao(value: string): boolean {
  return /^[A-Z0-9]{2,4}$/.test(value);
}

/** General registration syntax, not a country-specific registration scheme. */
export function isAircraftRegistration(value: string): boolean {
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value) && value.length >= 2 && value.length <= 16;
}

export function isFlightNumber(value: string): boolean {
  return /^\d{1,4}$/.test(value);
}

/**
 * Validates only the FlightRecord fields that this dialog edits directly.
 * Resource-path and boarding-pass-layout constraints intentionally remain
 * server-side because they are controlled backend data rather than form input.
 */
export function validateFlightInput(input: FlightInputForValidation): FlightValidationErrors {
  const errors: FlightValidationErrors = {};
  const requiredOrFormat = (field: FlightValidationField, value: string, valid: (candidate: string) => boolean) => {
    if (!value) errors[field] = 'required';
    else if (!valid(value)) errors[field] = 'format';
  };

  requiredOrFormat('flightNumber', input.flightNumber, isFlightNumber);
  requiredOrFormat('airlineCode', input.airlineCode, isAirlineCode);
  requiredOrFormat('departureAirport', input.departureAirport, isAirportCode);
  requiredOrFormat('arrivalAirport', input.arrivalAirport, isAirportCode);
  requiredOrFormat('departureDate', input.departureDate, (value) => normalizeDate(value) === value);

  if (input.departureTime && normalizeTime(input.departureTime) !== input.departureTime) errors.departureTime = 'format';
  if (input.arrivalTime && normalizeTime(input.arrivalTime) !== input.arrivalTime) errors.arrivalTime = 'format';
  if (input.aircraftTypeIcao && !isAircraftTypeIcao(input.aircraftTypeIcao)) errors.aircraftTypeIcao = 'format';
  if (input.registration && !isAircraftRegistration(input.registration)) errors.registration = 'format';

  return errors;
}
