// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import { containCanvasGeometry, rotationControlInsetForCrop } from './CropCanvas';

describe('containCanvasGeometry', () => {
  it.each([
    ['wide', 4000, 400, 560, 420, 0.14],
    ['tall', 400, 4000, 560, 420, 0.105],
    ['extremely wide', 100000, 100, 560, 420, 0.0056],
    ['extremely tall', 100, 100000, 560, 420, 0.0042],
  ])('contains a %s source by its constrained edge', (_name, imageWidth, imageHeight, workspaceWidth, workspaceHeight, expectedScale) => {
    const geometry = containCanvasGeometry(imageWidth, imageHeight, workspaceWidth, workspaceHeight, 2);

    expect(geometry.canvasWidth).toBe(workspaceWidth * 2);
    expect(geometry.canvasHeight).toBe(workspaceHeight * 2);
    expect(geometry.sourceScale).toBeCloseTo(expectedScale);
    expect(imageWidth * geometry.sourceScale).toBeLessThanOrEqual(workspaceWidth);
    expect(imageHeight * geometry.sourceScale).toBeLessThanOrEqual(workspaceHeight);
    expect(geometry.backingScale).toBeCloseTo(expectedScale * 2);
  });

  it('uses the available workspace for a small source instead of retaining a 1:1 cap', () => {
    const geometry = containCanvasGeometry(400, 200, 560, 420, 2);

    expect(geometry.sourceScale).toBeCloseTo(1.4);
    expect(geometry.backingScale).toBeCloseTo(2.8);
  });

  it('reserves a control gutter only when a rotated paper crop needs it', () => {
    const edgeInset = rotationControlInsetForCrop(5600, 4200, 560, 420, { centerX: 2800, centerY: 2100, width: 5600, height: 4200, rotationDegrees: 0 });
    const insetCrop = rotationControlInsetForCrop(5600, 4200, 560, 420, { centerX: 2800, centerY: 2100, width: 4800, height: 3400, rotationDegrees: 0 });
    const geometry = containCanvasGeometry(5600, 4200, 560, 420, 2, edgeInset);

    expect(edgeInset).toBeGreaterThan(0);
    expect(insetCrop).toBeLessThan(edgeInset);
    expect(5600 * geometry.sourceScale).toBeLessThanOrEqual(560 - edgeInset * 2);
  });
});
