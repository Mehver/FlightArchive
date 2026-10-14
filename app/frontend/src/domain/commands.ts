// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { normalizeAircraftType, normalizeAirline, normalizeAirport, normalizeFlight, parseBusinessDataV1 } from './schemaV1';
import type { BusinessData, CatalogKind, FlightRecord } from './types';
import { DomainValidationError } from './validation';

export interface CommandDependencies { now: () => string; newId: () => string }
export class DomainNotFoundError extends Error {}
export class DomainConflictError extends Error {}
const MAX_ID_GENERATION_ATTEMPTS = 8;

export function createFlight(data: BusinessData, input: unknown, dependencies: CommandDependencies, options: { inboxDraft?: boolean } = {}): BusinessData {
  const now = dependencies.now();
  let generatedIds = 0;
  const generateId = () => {
    if (generatedIds >= MAX_ID_GENERATION_ATTEMPTS) throw new DomainConflictError('could not generate a unique flight id');
    generatedIds += 1; return dependencies.newId();
  };
  const flight = normalizeFlight(input, { id: generateId, now: () => now }, { submission: true, inboxDraft: options.inboxDraft });
  const usedIds = new Set(data.flights.map((item) => item.id));
  while (usedIds.has(flight.id)) flight.id = generateId();
  flight.createdAt = now; flight.updatedAt = now;
  return { ...data, flights: [...data.flights, flight] };
}

export function updateFlight(data: BusinessData, id: string, changes: unknown, dependencies: CommandDependencies, options: { inboxDraft?: boolean } = {}): BusinessData {
  const index = data.flights.findIndex((flight) => flight.id === id);
  if (index < 0) throw new DomainNotFoundError(`flight ${id} not found`);
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) throw new Error('flight changes must be an object');
  const existing = data.flights[index];
  const changeSet = changes as Partial<FlightRecord>;
  const selectedLayouts = Object.hasOwn(changes, 'paperBoardingPassLayouts') ? changeSet.paperBoardingPassLayouts : existing.paperBoardingPassLayouts;
  const layouts = selectedLayouts === undefined ? undefined : { ...selectedLayouts };
  const merged: FlightRecord = { ...existing, ...changeSet, id: existing.id, createdAt: existing.createdAt, paperBoardingPassLayouts: layouts };
  if (existing.paperBoardingPassFrontResourcePath !== merged.paperBoardingPassFrontResourcePath) delete merged.paperBoardingPassLayouts?.paperBoardingPassFront;
  if (existing.paperBoardingPassBackResourcePath !== merged.paperBoardingPassBackResourcePath) delete merged.paperBoardingPassLayouts?.paperBoardingPassBack;
  if (existing.electronicBoardingPassResourcePath !== merged.electronicBoardingPassResourcePath) merged.electronicBoardingPass = null;
  const now = dependencies.now();
  const updated = normalizeFlight(merged, { id: dependencies.newId, now: () => now }, { submission: true, inboxDraft: options.inboxDraft }); updated.updatedAt = now;
  return { ...data, flights: data.flights.map((flight, itemIndex) => itemIndex === index ? updated : flight) };
}

export function deleteFlight(data: BusinessData, id: string): BusinessData {
  if (!data.flights.some((flight) => flight.id === id)) throw new DomainNotFoundError(`flight ${id} not found`);
  return { ...data, flights: data.flights.filter((flight) => flight.id !== id) };
}

function catalog(data: BusinessData, kind: CatalogKind): readonly Record<string, unknown>[] {
  if (kind === 'airlines') return data.airlines as unknown as readonly Record<string, unknown>[];
  if (kind === 'airports') return data.airports as unknown as readonly Record<string, unknown>[];
  return data.aircraftTypes as unknown as readonly Record<string, unknown>[];
}
function keyName(kind: CatalogKind): 'code' | 'icao' { return kind === 'aircraft-types' ? 'icao' : 'code'; }

export function upsertCatalogEntry(data: BusinessData, kind: CatalogKind, key: string, changes: unknown, options: { inboxDraft?: boolean } = {}): BusinessData {
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) throw new Error('catalog changes must be an object');
  const normalizedKey = key.trim().toUpperCase(), keyField = keyName(kind);
  const existing = catalog(data, kind).find((entry) => entry[keyField] === normalizedKey) ?? {};
  const raw = { ...existing, ...changes, [keyField]: normalizedKey };
  if (kind === 'airlines') return { ...data, airlines: [...data.airlines.filter((item) => item.code !== normalizedKey), normalizeAirline(raw, { submission: true, inboxDraft: options.inboxDraft })] };
  if (kind === 'airports') return { ...data, airports: [...data.airports.filter((item) => item.code !== normalizedKey), normalizeAirport(raw)] };
  return { ...data, aircraftTypes: [...data.aircraftTypes.filter((item) => item.icao !== normalizedKey), normalizeAircraftType(raw)] };
}

export function deleteCatalogEntries(data: BusinessData, kind: CatalogKind, keys: readonly string[], force = false): BusinessData {
  const normalized = [...new Set(keys.map((key) => key.trim().toUpperCase()).filter(Boolean))];
  if (normalized.length === 0 || normalized.length > 256) throw new DomainValidationError(['catalog deletion requires 1..256 unique keys']);
  const entries = catalog(data, kind), keyField = keyName(kind);
  const missing = normalized.find((key) => !entries.some((entry) => entry[keyField] === key));
  if (missing) throw new DomainNotFoundError(`${kind} entry ${missing} not found`);
  const referenced = normalized.some((key) => data.flights.some((flight) => kind === 'airlines' ? flight.airlineCode === key : kind === 'airports' ? flight.departureAirport === key || flight.arrivalAirport === key : flight.aircraftTypeIcao === key));
  if (referenced && !force) throw new DomainConflictError(`${kind} entries are referenced by flights`);
  if (kind === 'airlines') return { ...data, airlines: data.airlines.filter((entry) => !normalized.includes(entry.code)) };
  if (kind === 'airports') return { ...data, airports: data.airports.filter((entry) => !normalized.includes(entry.code)) };
  return { ...data, aircraftTypes: data.aircraftTypes.filter((entry) => !normalized.includes(entry.icao)) };
}

export function updateSettings(data: BusinessData, settings: unknown): BusinessData {
  return parseBusinessDataV1({ ...data, settings });
}
