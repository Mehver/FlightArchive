// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, test } from 'vitest';
import { sampleColorAtCenter } from './colorExtraction';

function imageData(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 255]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set(fill, index);
  return { width, height, data } as ImageData;
}

function setPixel(pixels: ImageData, x: number, y: number, color: [number, number, number, number]) {
  pixels.data.set(color, (y * pixels.width + x) * 4);
}

describe('sampleColorAtCenter', () => {
  test('returns null for empty crop', () => {
    expect(sampleColorAtCenter(imageData(3, 3), { x: 0, y: 0, width: 0, height: 3 })).toBeNull();
  });

  test('samples center window average', () => {
    const pixels = imageData(5, 5, [10, 20, 30, 255]);
    setPixel(pixels, 2, 2, [100, 110, 120, 255]);
    expect(sampleColorAtCenter(pixels, { x: 0, y: 0, width: 5, height: 5 }, 1)).toEqual({ r: 100, g: 110, b: 120 });
    expect(sampleColorAtCenter(pixels, { x: 0, y: 0, width: 5, height: 5 }, 5)).toEqual({ r: 14, g: 24, b: 34 });
  });
});
