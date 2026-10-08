// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const businessUiFiles = [
  '../flights/FlightsPage.tsx',
  '../reference/ReferenceLibraryPage.tsx',
  '../scanstudio/PaperBoardingPassStudio.tsx',
  '../scanstudio/ElectronicBoardingPassStudio.tsx',
];

describe('frontend business-data authority', () => {
  it('does not call the retired flight or catalog HTTP clients from business UI', () => {
    for (const relativePath of businessUiFiles) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source).not.toMatch(/api\.(?:listFlights|createFlight|updateFlight|deleteFlight|getCatalogs|putCatalogEntry|deleteCatalogEntries)\b/);
    }
  });
});
