// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause


/** Internal sRGB triple used for pixel-level extraction math. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const TRANSPARENT_ALPHA = 128;

/** Sample the center of a crop using a small average window to reduce image noise. */
export function sampleColorAtCenter(pixels: ImageData, crop: PixelRect, windowSize = 5): RgbColor | null {
  if (!isUsableRect(crop) || !Number.isFinite(windowSize) || windowSize < 1) return null;

  const centerX = Math.floor(crop.x + crop.width / 2);
  const centerY = Math.floor(crop.y + crop.height / 2);
  const halfWindow = Math.floor(windowSize / 2);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let dy = -halfWindow; dy <= halfWindow; dy++) {
    for (let dx = -halfWindow; dx <= halfWindow; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;
      if (!isInBounds(pixels, x, y)) continue;

      const index = (y * pixels.width + x) * 4;
      if (pixels.data[index + 3] < TRANSPARENT_ALPHA) continue;
      r += pixels.data[index];
      g += pixels.data[index + 1];
      b += pixels.data[index + 2];
      count++;
    }
  }

  return count === 0 ? null : { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}


function isUsableRect(crop: PixelRect): boolean {
  return [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) && crop.width > 0 && crop.height > 0;
}

function isInBounds(pixels: ImageData, x: number, y: number): boolean {
  return x >= 0 && x < pixels.width && y >= 0 && y < pixels.height;
}
