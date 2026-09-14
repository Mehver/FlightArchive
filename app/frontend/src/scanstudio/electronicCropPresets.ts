// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Named electronic boarding-pass crop presets are derived from FlightRecord
 * layouts. Only the last free-form crop remains a local UI convenience.
 */

import type { FlightRecord } from '../api/types';

/** Axis-aligned source-image crop region; rotation is not part of this model. */
export interface ElectronicCropRegion {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

/** A named crop region derived from an electronic boarding-pass layout. */
export interface ElectronicCropPreset {
  name: string;
  crop: ElectronicCropRegion;
  mirrorAcrossImageCenterX: boolean;
}

export const ELECTRONIC_CROP_PRESETS_STORAGE_KEY = 'flightarchive.ui.electronicCropPresets';
/**
 * Persists the most recent axis-aligned crop region and mirror flag chosen in
 * the electronic studio. This is UI state, independent from any flight
 * record, so the next editing session can restore the user's last region
 * without coupling the crop to business data.
 */
export const ELECTRONIC_LAST_CROP_STORAGE_KEY = 'flightarchive.ui.electronicLastCrop';
/** Matches the backend limit for `extraction.presetName`. */
export const PRESET_NAME_MAX_LENGTH = 128;
/**
 * The backend requires a nonempty `extraction.presetName` whenever extraction
 * data is persisted, so an unnamed crop is saved under this reserved name and
 * no local preset entry is created for it.
 */
export const DEFAULT_PRESET_NAME = 'custom';

const MIN_CROP_SIZE = 1;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidElectronicCropRegion(value: unknown): value is ElectronicCropRegion {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isFiniteNumber(candidate.centerX) &&
    isFiniteNumber(candidate.centerY) &&
    isFiniteNumber(candidate.width) &&
    isFiniteNumber(candidate.height) &&
    candidate.width >= MIN_CROP_SIZE &&
    candidate.height >= MIN_CROP_SIZE
  );
}

/** Remove the retired browser-only preset database; failures are non-fatal. */
export function clearLegacyElectronicCropPresetCache(): void {
  try {
    localStorage.removeItem(ELECTRONIC_CROP_PRESETS_STORAGE_KEY);
  } catch {
    /* storage may be unavailable */
  }
}

function namedPresetName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, PRESET_NAME_MAX_LENGTH);
  // "custom" represents an unnamed crop persisted to satisfy the backend's
  // required field, not a reusable named layout.
  return name && name !== DEFAULT_PRESET_NAME ? name : null;
}

function samePresetGeometry(a: ElectronicCropPreset, b: ElectronicCropPreset): boolean {
  return a.mirrorAcrossImageCenterX === b.mirrorAcrossImageCenterX
    && a.crop.centerX === b.crop.centerX
    && a.crop.centerY === b.crop.centerY
    && a.crop.width === b.crop.width
    && a.crop.height === b.crop.height;
}

/**
 * Build picker entries from currently loaded business records only. Sorting by
 * flight ID makes duplicate names stable; the first valid layout wins if a
 * duplicate name intentionally refers to different crop geometry.
 */
export function electronicCropPresetsFromFlights(flights: FlightRecord[]): ElectronicCropPreset[] {
  const presets: ElectronicCropPreset[] = [];
  for (const flight of [...flights].sort((a, b) => a.id.localeCompare(b.id))) {
    const extraction = flight.electronicBoardingPass?.extraction;
    const name = namedPresetName(extraction?.presetName);
    if (!flight.electronicBoardingPassResourcePath || !extraction || !name || !isValidElectronicCropRegion(extraction.crop) || typeof extraction.crop.mirrorAcrossImageCenterX !== 'boolean') continue;
    const preset: ElectronicCropPreset = {
      name,
      crop: {
        centerX: extraction.crop.centerX,
        centerY: extraction.crop.centerY,
        width: extraction.crop.width,
        height: extraction.crop.height,
      },
      mirrorAcrossImageCenterX: extraction.crop.mirrorAcrossImageCenterX,
    };
    const existing = presets.find((candidate) => candidate.name === name);
    if (!existing) presets.push(preset);
    else if (samePresetGeometry(existing, preset)) continue;
  }
  return presets;
}

/** Clamp an axis-aligned region so it stays fully inside the source image. */
export function clampElectronicCropToBounds(crop: ElectronicCropRegion, bounds: { width: number; height: number }): ElectronicCropRegion {
  const width = Math.min(Math.max(crop.width, MIN_CROP_SIZE), bounds.width);
  const height = Math.min(Math.max(crop.height, MIN_CROP_SIZE), bounds.height);
  return {
    centerX: Math.min(Math.max(crop.centerX, width / 2), bounds.width - width / 2),
    centerY: Math.min(Math.max(crop.centerY, height / 2), bounds.height - height / 2),
    width,
    height,
  };
}

/** Round a region to two decimals without pushing an edge-adjacent crop out of bounds. */
export function normalizeElectronicCrop(crop: ElectronicCropRegion, bounds: { width: number; height: number }): ElectronicCropRegion {
  const round2 = (value: number) => Math.round(value * 100) / 100;
  return clampElectronicCropToBounds(
    { centerX: round2(crop.centerX), centerY: round2(crop.centerY), width: round2(crop.width), height: round2(crop.height) },
    bounds,
  );
}

/** Shape of the locally persisted last-used electronic crop. */
export interface ElectronicLastCrop {
  crop: ElectronicCropRegion;
  mirrorAcrossImageCenterX: boolean;
}

function isValidLastCrop(value: unknown): value is ElectronicLastCrop {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isValidElectronicCropRegion(candidate.crop) && typeof candidate.mirrorAcrossImageCenterX === 'boolean';
}

/** Read the last-used electronic crop from localStorage, or null when absent/malformed. */
export function loadElectronicLastCrop(): ElectronicLastCrop | null {
  try {
    const raw = localStorage.getItem(ELECTRONIC_LAST_CROP_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidLastCrop(parsed) ? { crop: { ...parsed.crop }, mirrorAcrossImageCenterX: parsed.mirrorAcrossImageCenterX } : null;
  } catch {
    return null;
  }
}

/** Persist the last-used electronic crop to localStorage. */
export function saveElectronicLastCrop(last: ElectronicLastCrop): void {
  try {
    localStorage.setItem(ELECTRONIC_LAST_CROP_STORAGE_KEY, JSON.stringify(last));
  } catch {
    /* storage may be unavailable; the in-memory crop still applies */
  }
}
