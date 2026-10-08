// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { AircraftType, Airline, Airport, BusinessData, ElectronicBoardingPassPresentation, FlightRecord } from './types';
import { assertAllowed, assertStableResourcePath, DomainValidationError, hexColor, isRecord, optionalString, parsePaperLayout, stringList, stringValue } from './validation';

const AIRCRAFT_FIELDS = ['icao', 'iata', 'manufacturer', 'displayName'];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DomainValidationError([`${label} must be an object`]);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new DomainValidationError([`${label} must be an array`]);
  return value;
}

function rejectLegacyFields(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(rejectLegacyFields); return; }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (['local_path', 'status', 'primaryBrandColor', 'contrastBrandColor', 'boardingPassPrimaryColor', 'boardingPassContrastColor', 'assetTags'].includes(key) || key.endsWith('AssetId') || key.endsWith('AssetIds')) {
      throw new DomainValidationError([`business data may not contain legacy or local field ${key}`]);
    }
    rejectLegacyFields(child);
  }
}

export function normalizeAirline(value: unknown, options: { submission?: boolean } = {}): Airline {
  const raw = object(value, 'airline');
  const colors = raw.brandColors === undefined ? {} : object(raw.brandColors, 'airline.brandColors');
  if (options.submission && raw.brandColors !== undefined) {
    if (Object.keys(colors).length !== 2 || !Object.hasOwn(colors, 'primary') || !Object.hasOwn(colors, 'contrast')) throw new DomainValidationError(['airline.brandColors must contain exactly primary and contrast']);
    if ((colors.primary !== null && hexColor(colors.primary) === null) || (colors.contrast !== null && hexColor(colors.contrast) === null)) throw new DomainValidationError(['airline brand colors must be null or 6-digit hex strings']);
  }
  if (options.submission) for (const field of ['horizontalLogoResourcePath', 'horizontalDarkLogoResourcePath', 'symbolLogoResourcePath'] as const) {
    if (raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== 'string') throw new DomainValidationError([`airline.${field} must be null or a resource path`]);
    if (typeof raw[field] === 'string') assertStableResourcePath(raw[field], `airline.${field}`);
  }
  const airline: Airline = {
    code: stringValue(raw.code, 8).toUpperCase(), icao: stringValue(raw.icao, 8).toUpperCase(), nameZh: stringValue(raw.nameZh, 128), nameEn: stringValue(raw.nameEn, 128),
    alliance: optionalString(raw.alliance, 64), horizontalLogoResourcePath: optionalString(raw.horizontalLogoResourcePath), horizontalDarkLogoResourcePath: optionalString(raw.horizontalDarkLogoResourcePath),
    symbolLogoResourcePath: optionalString(raw.symbolLogoResourcePath), brandColors: { primary: hexColor(colors.primary), contrast: hexColor(colors.contrast) },
  };
  if (!/^[A-Z0-9]{2,3}$/.test(airline.code) || (airline.icao !== '' && !/^[A-Z]{3}$/.test(airline.icao)) || !(airline.nameZh || airline.nameEn)) throw new DomainValidationError(['airline identifiers and name are invalid']);
  assertStableResourcePath(airline.horizontalLogoResourcePath, 'airline.horizontalLogoResourcePath'); assertStableResourcePath(airline.horizontalDarkLogoResourcePath, 'airline.horizontalDarkLogoResourcePath'); assertStableResourcePath(airline.symbolLogoResourcePath, 'airline.symbolLogoResourcePath');
  return airline;
}

export function normalizeAirport(value: unknown): Airport {
  const raw = object(value, 'airport');
  const airport: Airport = { code: stringValue(raw.code, 8).toUpperCase(), icao: stringValue(raw.icao, 8).toUpperCase(), nameZh: stringValue(raw.nameZh, 128), nameEn: stringValue(raw.nameEn, 128), cityZh: stringValue(raw.cityZh, 128), cityEn: stringValue(raw.cityEn, 128), countryZh: stringValue(raw.countryZh, 128), countryEn: stringValue(raw.countryEn, 128), terminals: stringList(raw.terminals, 32) };
  if (!/^[A-Z]{3,4}$/.test(airport.code) || (airport.icao !== '' && !/^[A-Z]{4}$/.test(airport.icao)) || !(airport.nameZh || airport.nameEn)) throw new DomainValidationError(['airport identifiers and name are invalid']);
  return airport;
}

export function normalizeAircraftType(value: unknown): AircraftType {
  const raw = object(value, 'aircraft type'); assertAllowed(raw, AIRCRAFT_FIELDS, 'aircraft type');
  const aircraft: AircraftType = { icao: stringValue(raw.icao, 8).toUpperCase(), iata: stringValue(raw.iata, 8), manufacturer: optionalString(raw.manufacturer, 128), displayName: stringValue(raw.displayName, 128) };
  if (!/^[A-Z0-9]{2,4}$/.test(aircraft.icao) || (aircraft.iata !== '' && !/^[A-Z0-9]{3}$/.test(aircraft.iata)) || !aircraft.displayName) throw new DomainValidationError(['aircraft type identifiers and displayName are invalid']);
  return aircraft;
}

function normalizeElectronic(value: unknown, hasResource: boolean): ElectronicBoardingPassPresentation | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, 'electronicBoardingPass'); assertAllowed(raw, ['schemaVersion', 'extraction'], 'electronicBoardingPass');
  if (raw.schemaVersion !== 1 || !hasResource) throw new DomainValidationError(['electronicBoardingPass is invalid']);
  if (raw.extraction === null || raw.extraction === undefined) return { schemaVersion: 1, extraction: null };
  const extraction = object(raw.extraction, 'electronicBoardingPass.extraction'); assertAllowed(extraction, ['crop', 'presetName'], 'electronicBoardingPass.extraction');
  const crop = object(extraction.crop, 'electronicBoardingPass.extraction.crop');
  const presetName = extraction.presetName;
  if (typeof presetName !== 'string' || !presetName.trim() || presetName.length > 128) throw new DomainValidationError(['electronicBoardingPass.extraction.presetName must be a nonempty string of at most 128 characters']);
  return { schemaVersion: 1, extraction: { crop: crop as unknown as NonNullable<ElectronicBoardingPassPresentation['extraction']>['crop'], ...(presetName === undefined ? {} : { presetName }) } };
}

export function normalizeFlight(value: unknown, defaults: { id: () => string; now: () => string }, options: { submission?: boolean } = {}): FlightRecord {
  const raw = object(value, 'flight');
  for (const legacy of ['boardingPassPrimaryColor', 'boardingPassContrastColor']) if (Object.hasOwn(raw, legacy)) throw new DomainValidationError([`flight.${legacy} is no longer supported; use boardingPassColor`]);
  const layoutsRaw = raw.paperBoardingPassLayouts === undefined ? {} : object(raw.paperBoardingPassLayouts, 'paperBoardingPassLayouts');
  assertAllowed(layoutsRaw, ['paperBoardingPassFront', 'paperBoardingPassBack'], 'paperBoardingPassLayouts');
  for (const field of ['paperBoardingPassFrontResourcePath', 'paperBoardingPassBackResourcePath', 'electronicBoardingPassResourcePath'] as const) {
    if (options.submission && raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== 'string') throw new DomainValidationError([`flight.${field} must be null or a resource path`]);
    if (options.submission && typeof raw[field] === 'string') assertStableResourcePath(raw[field], `flight.${field}`);
  }
  if (options.submission && raw.attachmentResourcePaths !== undefined && (!Array.isArray(raw.attachmentResourcePaths) || raw.attachmentResourcePaths.length > 32 || raw.attachmentResourcePaths.some((path) => typeof path !== 'string'))) throw new DomainValidationError(['flight.attachmentResourcePaths must be an array of at most 32 resource paths']);
  if (options.submission && Array.isArray(raw.attachmentResourcePaths)) raw.attachmentResourcePaths.forEach((path) => assertStableResourcePath(path as string, 'flight attachment'));
  const front = optionalString(raw.paperBoardingPassFrontResourcePath), back = optionalString(raw.paperBoardingPassBackResourcePath), electronicPath = optionalString(raw.electronicBoardingPassResourcePath);
  const layouts: NonNullable<FlightRecord['paperBoardingPassLayouts']> = {};
  for (const slot of ['paperBoardingPassFront', 'paperBoardingPassBack'] as const) if (layoutsRaw[slot] !== undefined) {
    if ((slot === 'paperBoardingPassFront' ? front : back) === null) throw new DomainValidationError([`${slot} layout requires its resource path`]);
    layouts[slot] = parsePaperLayout(layoutsRaw[slot], slot);
  }
  const attachments = stringList(raw.attachmentResourcePaths, 32, 512);
  assertStableResourcePath(front, 'flight front resource'); assertStableResourcePath(back, 'flight back resource'); assertStableResourcePath(electronicPath, 'flight electronic resource'); attachments.forEach((path) => assertStableResourcePath(path, 'flight attachment'));
  const registration = optionalString(raw.registration, 64)?.toUpperCase() ?? null;
  const flight: FlightRecord = {
    id: stringValue(raw.id, 64) || defaults.id(), flightNumber: stringValue(raw.flightNumber, 12), airlineCode: stringValue(raw.airlineCode, 8).toUpperCase(), departureAirport: stringValue(raw.departureAirport, 8).toUpperCase(), arrivalAirport: stringValue(raw.arrivalAirport, 8).toUpperCase(),
    departureTerminal: optionalString(raw.departureTerminal, 16), arrivalTerminal: optionalString(raw.arrivalTerminal, 16), departureDate: stringValue(raw.departureDate, 10), departureTime: optionalString(raw.departureTime, 8), arrivalTime: optionalString(raw.arrivalTime, 8), aircraftTypeIcao: optionalString(raw.aircraftTypeIcao, 8)?.toUpperCase() ?? null,
    registration, seat: optionalString(raw.seat, 8), notes: stringValue(raw.notes, 4096), createdAt: stringValue(raw.createdAt, 40) || defaults.now(), updatedAt: stringValue(raw.updatedAt, 40) || defaults.now(), paperBoardingPassFrontResourcePath: front, paperBoardingPassBackResourcePath: back, electronicBoardingPassResourcePath: electronicPath,
    attachmentResourcePaths: attachments, paperBoardingPassLayouts: layouts, electronicBoardingPass: normalizeElectronic(raw.electronicBoardingPass, electronicPath !== null), boardingPassColor: hexColor(raw.boardingPassColor),
  };
  const parsedDate = new Date(`${flight.departureDate}T00:00:00Z`);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(flight.departureDate) && !Number.isNaN(parsedDate.valueOf()) && parsedDate.toISOString().slice(0, 10) === flight.departureDate;
  if (!/^\d{1,4}$/.test(flight.flightNumber) || !/^[A-Z0-9]{2,3}$/.test(flight.airlineCode) || !/^[A-Z]{3,4}$/.test(flight.departureAirport) || !/^[A-Z]{3,4}$/.test(flight.arrivalAirport) || !date) throw new DomainValidationError(['flight required fields are invalid']);
  if (flight.departureTime !== null && !/^\d{2}:\d{2}(:\d{2})?$/.test(flight.departureTime)) throw new DomainValidationError(['flight departureTime is invalid']);
  if (flight.arrivalTime !== null && !/^\d{2}:\d{2}(:\d{2})?$/.test(flight.arrivalTime)) throw new DomainValidationError(['flight arrivalTime is invalid']);
  if (flight.aircraftTypeIcao !== null && !/^[A-Z0-9]{2,4}$/.test(flight.aircraftTypeIcao)) throw new DomainValidationError(['flight aircraftTypeIcao is invalid']);
  if (registration !== null && (registration.length < 2 || registration.length > 16 || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(registration))) throw new DomainValidationError(['flight registration is invalid']);
  return flight;
}

export function parseBusinessDataV1(value: unknown): BusinessData {
  const raw = object(value, 'business data'); rejectLegacyFields(raw); assertAllowed(raw, ['schemaVersion', 'airlines', 'airports', 'aircraftTypes', 'flights', 'settings'], 'business data');
  if (raw.schemaVersion !== 1) throw new DomainValidationError(['business data schemaVersion must be exactly 1']);
  const airlines = array(raw.airlines, 'business data airlines');
  const airports = array(raw.airports, 'business data airports');
  const aircraftTypes = array(raw.aircraftTypes, 'business data aircraftTypes');
  const flights = array(raw.flights, 'business data flights');
  const settingsRaw = object(raw.settings, 'business data settings');
  const settings = Object.fromEntries(Object.entries(settingsRaw).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, item]) => [key.slice(0, 128), item.slice(0, 4096)]).sort(([left], [right]) => left.localeCompare(right)));
  const required = { id: () => { throw new DomainValidationError(['persisted flight id is required']); }, now: () => { throw new DomainValidationError(['persisted flight timestamps are required']); } };
  const keyed = <T>(items: readonly unknown[], normalize: (item: unknown) => T, key: (item: T) => string): T[] => {
    const values = new Map<string, T>();
    for (const item of items) { const normalized = normalize(item); values.set(key(normalized), normalized); }
    return [...values.values()].sort((left, right) => key(left).localeCompare(key(right)));
  };
  const normalizedFlights = keyed(flights, (flight) => normalizeFlight(flight, required), (flight) => flight.id)
    .sort((left, right) => left.departureDate.localeCompare(right.departureDate) || (left.departureTime ?? '').localeCompare(right.departureTime ?? '') || left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    airlines: keyed(airlines, normalizeAirline, (airline) => airline.code),
    airports: keyed(airports, normalizeAirport, (airport) => airport.code),
    aircraftTypes: keyed(aircraftTypes, normalizeAircraftType, (aircraft) => aircraft.icao),
    flights: normalizedFlights,
    settings,
  };
}
