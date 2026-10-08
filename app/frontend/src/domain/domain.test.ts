// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import fixture from '../../../test-fixtures/business-data-v1.json';
import {
  createFlight,
  deleteCatalogEntries,
  DomainConflictError,
  updateFlight,
  upsertCatalogEntry,
} from './commands';
import { normalizeAircraftType, normalizeAirline, normalizeAirport, parseBusinessDataV1 } from './schemaV1';
import { selectFlights } from './selectors';

const dependencies = {
  now: () => '2026-08-09T10:11:12+00:00',
  newId: () => 'generated-flight-id',
};

describe('BusinessData v1 golden fixture', () => {
  it('parses the valid aggregate and accepts ignored legacy crop corners', () => {
    const data = parseBusinessDataV1(fixture.validDocument);
    expect(data.schemaVersion).toBe(1);
    expect(data).toEqual(fixture.validDocument);
    expect(data.flights[0].paperBoardingPassLayouts?.paperBoardingPassFront?.crop.corners).toEqual([{ x: 1, y: 2 }]);
  });

  it('uses the shared last-wins and canonical ordering golden case', () => {
    const golden = fixture.duplicateNormalization;
    const airline = fixture.validDocument.airlines[0], airport = fixture.validDocument.airports[0];
    const aircraft = fixture.validDocument.aircraftTypes[0], flight = fixture.validDocument.flights[0];
    const data = parseBusinessDataV1({
      schemaVersion: 1,
      airlines: golden.input.airlineCodes.map((code, index) => ({ ...airline, code, icao: code === 'AA' ? 'AAA' : 'ZEX', nameEn: `airline-${index}` })),
      airports: golden.input.airportCodes.map((code, index) => ({ ...airport, code, icao: '', nameEn: `airport-${index}` })),
      aircraftTypes: golden.input.aircraftIcaos.map((icao, index) => ({ ...aircraft, icao, iata: icao === 'B738' ? '738' : '32N', displayName: `aircraft-${index}` })),
      flights: golden.input.flights.map((item, index) => ({ ...flight, ...item, flightNumber: String(index + 1) })),
      settings: {},
    });
    expect({
      airlineCodes: data.airlines.map((item) => item.code),
      airportCodes: data.airports.map((item) => item.code),
      aircraftIcaos: data.aircraftTypes.map((item) => item.icao),
      flightKeys: data.flights.map((item) => `${item.departureDate}|${item.departureTime ?? ''}|${item.id}`),
    }).toEqual(golden.expected);
    expect(data.airlines.find((item) => item.code === 'ZX')?.nameEn).toBe('airline-2');
    expect(data.flights.find((item) => item.id === 'same')?.flightNumber).toBe('3');
  });

  it.each(fixture.invalidDocuments)('rejects $name', ({ value }) => {
    expect(() => parseBusinessDataV1(value)).toThrow();
  });

  it('normalizes a create and uses injected time and IDs', () => {
    const data = parseBusinessDataV1(fixture.validDocument);
    const result = createFlight(data, fixture.normalization.flightInput, dependencies);
    const created = result.flights.at(-1)!;
    expect(created).toEqual(fixture.normalization.expectedFullFlight);
    expect(data.flights).toHaveLength(1);
  });

  it.each(fixture.invalidFlightInputs)('rejects invalid flight input $name', ({ value }) => {
    const data = parseBusinessDataV1(fixture.validDocument);
    expect(() => createFlight(data, value, dependencies)).toThrow();
  });

  it('removes presentation only when its resource changes', () => {
    const data = parseBusinessDataV1(fixture.validDocument);
    const mutation = fixture.layoutMutation;
    const changed = updateFlight(data, mutation.flightId, mutation.changes, dependencies);
    expect(changed.flights[0].paperBoardingPassLayouts?.[mutation.removedLayout as 'paperBoardingPassFront']).toBeUndefined();

    const unchanged = updateFlight(data, mutation.flightId, { notes: 'updated' }, dependencies);
    expect(unchanged.flights[0].paperBoardingPassLayouts?.paperBoardingPassFront).toBeDefined();
  });

  it('replaces an explicitly supplied layout dictionary so studio clear works', () => {
    const data = parseBusinessDataV1(fixture.validDocument);
    const changed = updateFlight(data, 'flight-1', fixture.updateCases.clearLayouts, dependencies);
    expect(changed.flights[0].paperBoardingPassLayouts).toEqual({});
  });

  it.each(fixture.electronicExtractionCases)('rejects electronic extraction $name', ({ value }) => {
    const data = parseBusinessDataV1(fixture.validDocument);
    expect(() => createFlight(data, {
      ...fixture.normalization.flightInput,
      electronicBoardingPassResourcePath: 'objects/passes/electronic.png',
      electronicBoardingPass: value,
    }, dependencies)).toThrow();
  });

  it('accepts a bounded electronic preset without trimming persisted content', () => {
    const data = parseBusinessDataV1(fixture.validDocument);
    const created = createFlight(data, {
      ...fixture.normalization.flightInput,
      electronicBoardingPassResourcePath: 'objects/passes/electronic.png',
      electronicBoardingPass: fixture.validElectronicExtraction,
    }, dependencies).flights.at(-1);
    expect(created?.electronicBoardingPass).toEqual(fixture.validElectronicExtraction);
  });

  it('matches catalog defaults and ignores ordinary future entity fields', () => {
    expect(normalizeAirline(fixture.catalogNormalization.airlineInput)).toEqual(fixture.catalogNormalization.airlineExpected);
    expect(normalizeAirport(fixture.catalogNormalization.airportInput)).toEqual(fixture.catalogNormalization.airportExpected);
    expect(normalizeAircraftType(fixture.catalogNormalization.aircraftTypeInput)).toEqual(fixture.catalogNormalization.aircraftTypeExpected);
    const data = parseBusinessDataV1(fixture.validDocument);
    expect(updateFlight(data, 'flight-1', fixture.updateCases.unknownFieldsIgnored, dependencies).flights[0].notes).toBe('kept update');
  });

  it('matches shipped raw color, resource, and settings behavior', () => {
    const data = parseBusinessDataV1({ ...fixture.validDocument, settings: fixture.settingsNormalization.input });
    expect(data.settings).toEqual(fixture.settingsNormalization.expected);
    expect(() => normalizeAirline(fixture.rawValidation.invalidAirlineColor, { submission: true })).toThrow();
    expect(normalizeAirline(fixture.rawValidation.invalidAirlineColor).brandColors.primary).toBeNull();
    const invalidColor = createFlight(data, { ...fixture.normalization.flightInput, boardingPassColor: fixture.rawValidation.invalidFlightColor }, dependencies);
    expect(invalidColor.flights.at(-1)?.boardingPassColor).toBeNull();
    expect(() => createFlight(data, { ...fixture.normalization.flightInput, paperBoardingPassFrontResourcePath: fixture.rawValidation.nonStringResource }, dependencies)).toThrow();
  });

  it('applies shipped catalog, settings, attachment, and resource limits', () => {
    const limits = fixture.limits;
    const airport = normalizeAirport({
      code: 'QZX',
      nameEn: 'x'.repeat(limits.string + 5),
      terminals: Array.from({ length: limits.terminalItems + 5 }, (_, index) => `${index}-${'x'.repeat(limits.terminalString + 5)}`),
    });
    expect(airport.nameEn).toHaveLength(limits.string);
    expect(airport.terminals).toHaveLength(limits.terminalItems);
    expect(airport.terminals[0]).toHaveLength(limits.terminalString);

    const longKey = 'k'.repeat(limits.settingsKey + 5), longValue = 'v'.repeat(limits.settingsValue + 5);
    const settings = parseBusinessDataV1({ ...fixture.validDocument, settings: { [longKey]: longValue } }).settings;
    expect(Object.keys(settings)[0]).toHaveLength(limits.settingsKey);
    expect(Object.values(settings)[0]).toHaveLength(limits.settingsValue);
    expect(() => createFlight(parseBusinessDataV1(fixture.validDocument), {
      ...fixture.normalization.flightInput,
      attachmentResourcePaths: Array.from({ length: limits.attachments + 1 }, (_, index) => `objects/${index}.txt`),
    }, dependencies)).toThrow();
    expect(() => createFlight(parseBusinessDataV1(fixture.validDocument), {
      ...fixture.normalization.flightInput,
      paperBoardingPassFrontResourcePath: `objects/${'x'.repeat(limits.resourcePath)}`,
    }, dependencies)).toThrow();
    expect(() => normalizeAirline({
      code: 'ZY', nameEn: 'Long Logo Air', horizontalLogoResourcePath: `objects/${'x'.repeat(limits.resourcePath)}`,
    }, { submission: true })).toThrow();
  });

  it('merge-upserts catalogs and keeps forced-delete flight references as direct values', () => {
    const data = parseBusinessDataV1(fixture.validDocument);
    const merge = fixture.catalogCrud.merge;
    const merged = upsertCatalogEntry(data, merge.kind as 'airlines', merge.key, merge.changes);
    expect(merged.airlines[0][merge.preservedField as 'icao']).toBe(merge.preservedValue);
    expect(merged.airlines[0].nameEn).toBe('Zulu Airways');

    const deletion = fixture.catalogCrud.referencedDelete;
    expect(() => deleteCatalogEntries(merged, deletion.kind as 'airlines', deletion.keys, deletion.force)).toThrow(DomainConflictError);
    const forced = fixture.catalogCrud.forcedDelete;
    const deleted = deleteCatalogEntries(merged, forced.kind as 'airlines', forced.keys, forced.force);
    expect(deleted.airlines).toEqual([]);
    expect(deleted.flights[0].airlineCode).toBe('ZX');
  });

  it('selects flights in legacy list order without mutating the aggregate', () => {
    const data = parseBusinessDataV1(fixture.validDocument);
    const withSecond = createFlight(data, { ...fixture.normalization.flightInput, departureDate: '2027-01-01' }, dependencies);
    expect(selectFlights(withSecond).map((flight) => flight.id)).toEqual(['generated-flight-id', 'flight-1']);
    expect(withSecond.flights.map((flight) => flight.id)).toEqual(['flight-1', 'generated-flight-id']);
  });
});
