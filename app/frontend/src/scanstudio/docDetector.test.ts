// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { afterEach, describe, expect, it, vi } from 'vitest';
import './docDetector.js';

const detector = (globalThis as unknown as {
  DocDetect: { matFromImageSource(source: unknown): unknown };
}).DocDetect;

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { cv?: unknown }).cv;
});

describe('DocDetect.matFromImageSource', () => {
  it('reads worker OffscreenCanvas pixels with matFromImageData without invoking imread', () => {
    class WorkerCanvas {
      width = 12;
      height = 8;
      getContext = vi.fn(() => ({ getImageData: vi.fn(() => ({ pixels: 'rgba' })) }));
    }
    const canvas = new WorkerCanvas();
    const matFromImageData = vi.fn(() => ({ kind: 'image-data-mat' }));
    const imread = vi.fn(() => { throw new Error('must not call imread in a worker'); });
    vi.stubGlobal('OffscreenCanvas', WorkerCanvas);
    (globalThis as { cv?: unknown }).cv = { matFromImageData, imread };

    expect(detector.matFromImageSource(canvas)).toEqual({ kind: 'image-data-mat' });
    expect(canvas.getContext).toHaveBeenCalledWith('2d');
    expect(matFromImageData).toHaveBeenCalledWith({ pixels: 'rgba' });
    expect(imread).not.toHaveBeenCalled();
  });

  it('keeps cv.imread for regular browser image and canvas sources', () => {
    const imread = vi.fn(() => ({ kind: 'imread-mat' }));
    vi.stubGlobal('OffscreenCanvas', undefined);
    (globalThis as { cv?: unknown }).cv = { imread };
    const source = { tagName: 'CANVAS' };

    expect(detector.matFromImageSource(source)).toEqual({ kind: 'imread-mat' });
    expect(imread).toHaveBeenCalledWith(source);
  });
});
