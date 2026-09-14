// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import type { FlightRecord } from '../api/types';
import {
  DEFAULT_PRESET_NAME,
  ELECTRONIC_CROP_PRESETS_STORAGE_KEY,
  clampElectronicCropToBounds,
  clearLegacyElectronicCropPresetCache,
  electronicCropPresetsFromFlights,
  normalizeElectronicCrop,
} from './electronicCropPresets';

function flight(id: string, options: { resource?: string | null; name?: string; crop?: unknown } = {}): FlightRecord {
  return {
    id,
    electronicBoardingPassResourcePath: options.resource === undefined ? 'passes/pass.png' : options.resource,
    electronicBoardingPass: {
      schemaVersion: 1,
      extraction: {
        presetName: options.name ?? 'Mobile',
        crop: options.crop ?? { centerX: 100, centerY: 50, width: 80, height: 40, mirrorAcrossImageCenterX: false },
      },
    },
  } as FlightRecord;
}

describe('electronicCropPresetsFromFlights', () => {
  it('uses only resource-backed named extraction layouts', () => {
    const entries = electronicCropPresetsFromFlights([
      flight('named', { name: '  Seat  ' }),
      flight('unnamed', { name: DEFAULT_PRESET_NAME }),
      flight('blank', { name: '   ' }),
      flight('released', { resource: null, name: 'Released' }),
      flight('invalid', { name: 'Invalid', crop: { centerX: 1, centerY: 2, width: 0, height: 3, mirrorAcrossImageCenterX: false } }),
    ]);

    expect(entries).toEqual([{ name: 'Seat', crop: { centerX: 100, centerY: 50, width: 80, height: 40 }, mirrorAcrossImageCenterX: false }]);
  });

  it('deduplicates names deterministically without exposing different duplicate geometry', () => {
    const entries = electronicCropPresetsFromFlights([
      flight('z-later', { name: 'Seat', crop: { centerX: 200, centerY: 50, width: 80, height: 40, mirrorAcrossImageCenterX: false } }),
      flight('a-first', { name: 'Seat' }),
      flight('b-copy', { name: 'Seat' }),
    ]);

    expect(entries).toEqual([{ name: 'Seat', crop: { centerX: 100, centerY: 50, width: 80, height: 40 }, mirrorAcrossImageCenterX: false }]);
  });
});

describe('legacy preset cache cleanup', () => {
  beforeEach(() => localStorage.clear());

  it('removes orphaned browser-only presets', () => {
    localStorage.setItem(ELECTRONIC_CROP_PRESETS_STORAGE_KEY, JSON.stringify([{ name: 'Old', crop: {} }]));
    clearLegacyElectronicCropPresetCache();
    expect(localStorage.getItem(ELECTRONIC_CROP_PRESETS_STORAGE_KEY)).toBeNull();
  });
});

describe('crop bounds', () => {
  it('clamps and normalizes source-image coordinates without changing their semantics', () => {
    expect(clampElectronicCropToBounds({ centerX: 10, centerY: 10, width: 100, height: 50 }, { width: 400, height: 200 })).toEqual({ centerX: 50, centerY: 25, width: 100, height: 50 });
    expect(normalizeElectronicCrop({ centerX: 199.999, centerY: 100, width: 400, height: 200 }, { width: 400, height: 200 })).toEqual({ centerX: 200, centerY: 100, width: 400, height: 200 });
  });
});
