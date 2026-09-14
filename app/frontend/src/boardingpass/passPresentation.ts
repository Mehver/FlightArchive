// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Pure presentation logic for boarding-pass display primitives.
 *
 * This module deliberately knows nothing about the scan studio, the bundled
 * paper templates, or image loading: it classifies each paper
 * independent boarding-pass slots and converts a persisted
 * {@link PaperBoardingPassLayout} into percentage geometry inside an abstract
 * template space. The fixed presentation frame and the actual template SVGs
 * live in `BoardingPassFrame.tsx`, so future electronic-pass or direct
 * positioning layouts can reuse the same math without touching archive UI.
 */

import type { FlightRecord, PaperBoardingPassLayout } from '../api/types';

/** The paper boarding-pass slots that use crop-and-placement layouts. */
export const BOARDING_PASS_SLOTS = [
  'paperBoardingPassFront',
  'paperBoardingPassBack',
 ] as const;

export type BoardingPassSlotKey = (typeof BOARDING_PASS_SLOTS)[number];

type ResourceField = 'paperBoardingPassFrontResourcePath' | 'paperBoardingPassBackResourcePath';

const SLOT_RESOURCE_FIELD: Record<BoardingPassSlotKey, ResourceField> = {
  paperBoardingPassFront: 'paperBoardingPassFrontResourcePath',
  paperBoardingPassBack: 'paperBoardingPassBackResourcePath',
};

export function slotResourcePath(flight: FlightRecord, slot: BoardingPassSlotKey): string | null {
  return flight[SLOT_RESOURCE_FIELD[slot]];
}

export function slotLayout(flight: FlightRecord, slot: BoardingPassSlotKey): PaperBoardingPassLayout | undefined {
  return flight.paperBoardingPassLayouts?.[slot];
}

/**
 * Presentation state of one slot, classified independently of the others:
 * - `prepared`: a resource is bound and a crop/placement layout was saved.
 * - `unprepared`: a resource is bound but has no saved layout (raw scan).
 * - `absent`: nothing is bound to the slot.
 */
export type SlotPresentationState = 'prepared' | 'unprepared' | 'absent';

export function slotState(resourcePath: string | null, layout: PaperBoardingPassLayout | undefined): SlotPresentationState {
  if (!resourcePath) return 'absent';
  return layout ? 'prepared' : 'unprepared';
}

/** Dimensions of the coordinate space a layout was authored in. */
export interface TemplateSpace {
  width: number;
  height: number;
}

/** Percentage geometry of the placed crop inside the template space. */
export interface PlacementBox {
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
  rotationDegrees: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * Convert a persisted layout into percentage geometry within the given
 * template space, using exactly the inverse of the studio's save formula
 * (`scale * width * 0.85`, centre + relative offsets, crop aspect). Returns
 * null when the persisted crop cannot define an aspect ratio — callers must
 * fall back to the honest `unprepared` presentation rather than guessing.
 */
export function placementBox(layout: PaperBoardingPassLayout, template: TemplateSpace): PlacementBox | null {
  const { crop, placement } = layout;
  if (!crop || !placement) return null;
  if (!Number.isFinite(crop.width) || !Number.isFinite(crop.height) || crop.width <= 0 || crop.height <= 0) return null;
  const croppedAspect = crop.width / crop.height;
  const w = clamp(placement.scale, 0.01, 10) * template.width * 0.85;
  const h = w / croppedAspect;
  const cx = template.width / 2 + clamp(placement.offsetX, -1, 1) * template.width;
  const cy = template.height / 2 + clamp(placement.offsetY, -1, 1) * template.height;
  return {
    leftPct: ((cx - w / 2) / template.width) * 100,
    topPct: ((cy - h / 2) / template.height) * 100,
    widthPct: (w / template.width) * 100,
    heightPct: (h / template.height) * 100,
    rotationDegrees: Number.isFinite(placement.rotationDegrees) ? placement.rotationDegrees : 0,
  };
}

/** Number of paper boarding-pass slots that currently have a resource bound (0–2). */
export function boundSlotCount(flight: FlightRecord): number {
  return BOARDING_PASS_SLOTS.filter((slot) => slotResourcePath(flight, slot) !== null).length;
}
