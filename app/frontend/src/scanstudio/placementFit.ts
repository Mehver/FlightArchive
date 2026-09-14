// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause
//
// Auto-fit placement calculations for Stage 2.

export type ScaleMode = 'long' | 'short';
export type Alignment = 'left' | 'center' | 'right';

export interface Placement {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotationDegrees: number;
}

export interface TemplateDimensions {
  width: number;
  height: number;
}

export interface CropDimensions {
  width: number;
  height: number;
}

/**
 * Calculate auto-fit placement.
 * - Long edge fit: the longer dimension of the crop fills the corresponding template dimension
 * - Short edge fit: the shorter dimension of the crop fills the corresponding template dimension
 * - Alignment determines horizontal position (left/center/right)
 * - Always centers vertically
 */
export function calculateAutoFit(
  crop: CropDimensions,
  template: TemplateDimensions,
  scaleMode: ScaleMode,
  alignment: Alignment,
): Placement {
  const aspect = crop.width / crop.height;
  const tplAspect = template.width / template.height;
  let w: number;
  let h: number;

  if (scaleMode === 'long') {
    if (aspect > tplAspect) {
      w = template.width;
      h = w / aspect;
    } else {
      h = template.height;
      w = h * aspect;
    }
  } else {
    if (aspect > tplAspect) {
      h = template.height;
      w = h * aspect;
    } else {
      w = template.width;
      h = w / aspect;
    }
  }

  let cx = template.width / 2;
  if (alignment === 'left') cx = w / 2;
  if (alignment === 'right') cx = template.width - w / 2;

  return { cx, cy: template.height / 2, w, h, rotationDegrees: 0 };
}
