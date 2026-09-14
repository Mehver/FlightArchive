// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import {
  isAirlineCode,
  isAircraftRegistration,
  isAircraftTypeIcao,
  isAirportCode,
  normalizeAirlineCode,
  normalizeAircraftRegistration,
  normalizeAirportCode,
  normalizeDate,
  normalizeFlightNumber,
  normalizeTime,
  validateFlightInput,
} from './flightFormat';

describe('flight form formats', () => {
  it('keeps only a four-digit flight suffix', () => {
    expect(normalizeFlightNumber(' CA-01234 ')).toBe('0123');
  });

  it('normalizes bounded airline and airport codes', () => {
    expect(normalizeAirlineCode(' c-a1234 ')).toBe('CA1');
    expect(normalizeAirportCode('pek-123')).toBe('PEK');
    expect(isAirlineCode('CA')).toBe(true);
    expect(isAirlineCode('C')).toBe(false);
    expect(isAirportCode('PEK')).toBe(true);
    expect(isAirportCode('P3K')).toBe(false);
  });

  it('accepts only 2–4 character ICAO aircraft type designators', () => {
    for (const code of ['AT', 'A3B', 'A320']) expect(isAircraftTypeIcao(code)).toBe(true);
    for (const code of ['A', 'A3200']) expect(isAircraftTypeIcao(code)).toBe(false);
  });

  it('normalizes and validates general aircraft registrations without assuming a country format', () => {
    expect(normalizeAircraftRegistration(' g-abcd ')).toBe('G-ABCD');
    for (const registration of ['B1234', 'G-ABCD', 'N123AB']) expect(isAircraftRegistration(registration)).toBe(true);
    for (const registration of ['A', 'A1234567890123456', 'N@123', '-N123', 'N123-', 'N--123']) {
      expect(isAircraftRegistration(registration)).toBe(false);
    }
  });

  it('normalizes valid dates and times while rejecting impossible values', () => {
    expect(normalizeDate('2026-2-3')).toBe('2026-02-03');
    expect(normalizeDate('2026-02-30')).toBe('');
    expect(normalizeTime('8:05')).toBe('08:05');
    expect(normalizeTime('24:00')).toBe('');
  });

  it('rejects the screenshot state before submission, including both missing airports', () => {
    expect(validateFlightInput({
      flightNumber: '001',
      airlineCode: 'CA',
      departureAirport: '',
      arrivalAirport: '',
      departureDate: '2026-08-29',
      departureTime: '',
      arrivalTime: '',
      aircraftTypeIcao: '',
      registration: '',
    })).toEqual({ departureAirport: 'required', arrivalAirport: 'required' });
  });

  it('accepts valid unlisted free-entry airline and airport codes', () => {
    expect(validateFlightInput({
      flightNumber: '42',
      airlineCode: 'Z9',
      departureAirport: 'ABCD',
      arrivalAirport: 'XYZ',
      departureDate: '2026-08-29',
      departureTime: '08:05',
      arrivalTime: '',
      aircraftTypeIcao: 'AT',
      registration: 'G-ABCD',
    })).toEqual({});
  });

  it('enforces every editable format without validating backend-only resource data', () => {
    expect(validateFlightInput({
      flightNumber: '12345',
      airlineCode: 'C',
      departureAirport: 'AB',
      arrivalAirport: 'A1A',
      departureDate: '2026-02-30',
      departureTime: '24:00',
      arrivalTime: '8:05',
      aircraftTypeIcao: 'A3200',
      registration: 'N--123',
    })).toEqual({
      flightNumber: 'format',
      airlineCode: 'format',
      departureAirport: 'format',
      arrivalAirport: 'format',
      departureDate: 'format',
      departureTime: 'format',
      arrivalTime: 'format',
      aircraftTypeIcao: 'format',
      registration: 'format',
    });
  });
});
