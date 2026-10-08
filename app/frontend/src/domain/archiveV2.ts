// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { parseBusinessDataV1 } from './schemaV1';
import type { BusinessData } from './types';
import { DomainValidationError, isRecord } from './validation';

export const BUSINESS_DATA_DOCUMENT_IDS = [
  'flights.json',
  'airlines.json',
  'airports.json',
  'aircraft-types.json',
  'settings.json',
] as const;

export type BusinessDataDocumentId = typeof BUSINESS_DATA_DOCUMENT_IDS[number];

export const BUSINESS_DATA_MANIFEST = {
  formatVersion: 1,
  businessDataSchemaVersion: 1,
  documents: [...BUSINESS_DATA_DOCUMENT_IDS],
} as const;

export type BusinessDataDocuments = {
  'flights.json': unknown;
  'airlines.json': unknown;
  'airports.json': unknown;
  'aircraft-types.json': unknown;
  'settings.json': unknown;
};

export function parseBusinessDataManifest(value: unknown): typeof BUSINESS_DATA_MANIFEST {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.formatVersion !== 1 || value.businessDataSchemaVersion !== 1 || !Array.isArray(value.documents)) {
    throw new DomainValidationError(['archive manifest does not match the fixed v2 format']);
  }
  if (value.documents.length !== BUSINESS_DATA_DOCUMENT_IDS.length || value.documents.some((item, index) => item !== BUSINESS_DATA_DOCUMENT_IDS[index])) {
    throw new DomainValidationError(['archive manifest documents do not match the fixed v2 layout']);
  }
  return BUSINESS_DATA_MANIFEST;
}

export function splitBusinessData(data: BusinessData): BusinessDataDocuments {
  return {
    'flights.json': data.flights,
    'airlines.json': data.airlines,
    'airports.json': data.airports,
    'aircraft-types.json': data.aircraftTypes,
    'settings.json': data.settings,
  };
}

export function aggregateBusinessData(documents: BusinessDataDocuments): BusinessData {
  return parseBusinessDataV1({
    schemaVersion: 1,
    flights: documents['flights.json'],
    airlines: documents['airlines.json'],
    airports: documents['airports.json'],
    aircraftTypes: documents['aircraft-types.json'],
    settings: documents['settings.json'],
  });
}
