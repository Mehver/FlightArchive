// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import { isQuadWithinBounds, moveQuadVertex, normalizeQuadGeometry, rectFromQuad, rectToQuad, rotateQuadWithinBounds, rotationHandlePoint } from './cropGeometry';

describe('rotated crop rectangle', () => {
  it('keeps right angles and the opposite corner fixed while resizing a corner', () => {
    const original = rectToQuad({ centerX: 100, centerY: 100, width: 80, height: 40, rotationDegrees: 25 });
    const next = moveQuadVertex(original, 0, { x: 40, y: 60 }, { width: 300, height: 300 });
    expect(next[2].x).toBeCloseTo(original[2].x, 10);
    expect(next[2].y).toBeCloseTo(original[2].y, 10);
    const r = rectFromQuad(next);
    expect(r.width).toBeGreaterThanOrEqual(4);
    expect(r.height).toBeGreaterThanOrEqual(4);
    expect(Math.abs(r.rotationDegrees - 25)).toBeLessThan(0.001);
  });
  it('rejects rotations that leave the source bounds', () => {
    const q = rectToQuad({ centerX: 20, centerY: 20, width: 40, height: 20, rotationDegrees: 0 });
    expect(rotateQuadWithinBounds(q, 45, { width: 40, height: 40 })).toEqual(q);
    expect(isQuadWithinBounds(q, { width: 40, height: 40 })).toBe(true);
  });
  it('uses clockwise positive angles in canvas/source coordinates', () => {
    const [topLeft, topRight] = rectToQuad({ centerX: 100, centerY: 100, width: 80, height: 40, rotationDegrees: 90 });
    expect(topLeft).toMatchObject({ x: 120, y: 60 });
    expect(topRight).toMatchObject({ x: 120, y: 140 });
  });
  it('places the rotation handle outward from the rotated top edge', () => {
    const quad = rectToQuad({ centerX: 100, centerY: 100, width: 80, height: 40, rotationDegrees: 90 });

    expect(rotationHandlePoint(quad, 30)).toMatchObject({ x: 150, y: 100 });
  });
  it('does not round a valid edge-adjacent rectangle outside the source', () => {
    const bounds = { width: 500, height: 300 };
    const original = rectToQuad({ centerX: 449.9951, centerY: 150, width: 100.009, height: 80, rotationDegrees: 0 });

    const normalized = normalizeQuadGeometry(original, bounds);

    expect(isQuadWithinBounds(rectToQuad(normalized), bounds)).toBe(true);
    expect(normalized.centerX).not.toBe(450);
  });
});
