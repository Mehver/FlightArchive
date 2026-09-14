// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization of the boarding-pass presentation math: slot state
 * classification and the inverse of the studio's placement save formula.
 */

import { describe, expect, it } from 'vitest';
import type { PaperBoardingPassLayout } from '../api/types';
import { placementBox, slotState } from './passPresentation';

const TEMPLATE = { width: 247, height: 100 };

function layout(overrides: Partial<PaperBoardingPassLayout> = {}): PaperBoardingPassLayout {
  return {
    schemaVersion: 1,
    algorithm: 'adaptive',
    crop: { centerX: 100, centerY: 60, width: 200, height: 100, rotationDegrees: 0 },
    templateId: 'bp-247.svg',
    placement: { scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0 },
    ...overrides,
  };
}

describe('slotState', () => {
  it('classifies a slot with neither resource nor layout as absent', () => {
    expect(slotState(null, undefined)).toBe('absent');
  });

  it('classifies a bound resource without a layout as unprepared', () => {
    expect(slotState('inbox/scan.png', undefined)).toBe('unprepared');
  });

  it('classifies a bound resource with a saved layout as prepared', () => {
    expect(slotState('inbox/scan.png', layout())).toBe('prepared');
  });

  it('treats a layout without a bound resource as absent (nothing to show)', () => {
    expect(slotState(null, layout())).toBe('absent');
  });
});

describe('placementBox', () => {
  it('inverts the studio save formula for a centred, full-scale placement', () => {
    const box = placementBox(layout(), TEMPLATE);
    expect(box).not.toBeNull();
    // w = 1 * 247 * 0.85, h = w / (200/100), centred in the template.
    const w = 247 * 0.85;
    const h = w / 2;
    expect(box!.widthPct).toBeCloseTo((w / 247) * 100, 6);
    expect(box!.heightPct).toBeCloseTo(h, 6);
    expect(box!.leftPct).toBeCloseTo(((247 - w) / 2 / 247) * 100, 6);
    expect(box!.topPct).toBeCloseTo(((100 - h) / 2 / 100) * 100, 6);
    expect(box!.rotationDegrees).toBe(0);
  });

  it('applies relative offsets around the template centre', () => {
    const box = placementBox(
      layout({ placement: { scale: 0.5, rotationDegrees: 12, offsetX: 0.25, offsetY: -0.25 } }),
      TEMPLATE,
    );
    const w = 0.5 * 247 * 0.85;
    const h = w / 2;
    const cx = 247 / 2 + 0.25 * 247;
    const cy = 100 / 2 - 0.25 * 100;
    expect(box!.leftPct).toBeCloseTo(((cx - w / 2) / 247) * 100, 6);
    expect(box!.topPct).toBeCloseTo(((cy - h / 2) / 100) * 100, 6);
    expect(box!.rotationDegrees).toBe(12);
  });

  it('clamps out-of-range persisted values into the persisted envelope', () => {
    const box = placementBox(
      layout({ placement: { scale: 99, rotationDegrees: 0, offsetX: 5, offsetY: -5 } }),
      TEMPLATE,
    );
    const w = 10 * 247 * 0.85;
    const cx = 247 / 2 + 1 * 247;
    const cy = 100 / 2 - 1 * 100;
    expect(box!.leftPct).toBeCloseTo(((cx - w / 2) / 247) * 100, 6);
    expect(box!.topPct).toBeCloseTo(((cy - w / 2 / 2) / 100) * 100, 6);
  });

  it('returns null when the crop cannot define an aspect ratio', () => {
    expect(
      placementBox(layout({ crop: { centerX: 0, centerY: 0, width: 0, height: 100, rotationDegrees: 0 } }), TEMPLATE),
    ).toBeNull();
    expect(
      placementBox(
        layout({ crop: { centerX: 0, centerY: 0, width: Number.NaN, height: 100, rotationDegrees: 0 } }),
        TEMPLATE,
      ),
    ).toBeNull();
  });
});
