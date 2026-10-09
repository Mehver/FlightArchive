// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import { boundedCropOutputSize, isScanWorkerResponse, type WorkerCrop, type WorkerDetectionResult } from './scanWorkerProtocol';

describe('scan worker rectangle protocol', () => {
  it('uses detector centre, size and angle without corner payloads', () => {
    const result: WorkerDetectionResult = { center: { x: 50, y: 25 }, size: { width: 100, height: 50 }, rotation: 90 };
    const crop: WorkerCrop = { centerX: result.center.x, centerY: result.center.y, width: result.size.width, height: result.size.height, rotationDegrees: result.rotation };
    expect(crop).not.toHaveProperty('corners');
  });

  it('bounds huge crop previews without changing their aspect ratio', () => {
    const output = boundedCropOutputSize({ width: 12_000, height: 6_000 });
    expect(output).toEqual({ width: 2828, height: 1414 });
    expect(output.width * output.height).toBeLessThanOrEqual(4_000_000);
  });

  it('never rounds a constrained rotated-crop preview above the strict pixel budget', () => {
    const output = boundedCropOutputSize({ width: 11_200, height: 4_200 });
    expect(output.width * output.height).toBeLessThanOrEqual(4_000_000);
    expect(output).toEqual({ width: 3265, height: 1224 });
  });

  it('keeps a dimension-constrained preview at or below 4096 pixels per side', () => {
    const output = boundedCropOutputSize({ width: 5000, height: 100 });
    expect(output).toEqual({ width: 4096, height: 81 });
    expect(Math.max(output.width, output.height)).toBeLessThanOrEqual(4096);
  });

  it('corrects scale-one rounding when fractional source dimensions cross the pixel budget', () => {
    const output = boundedCropOutputSize({ width: 4001.49, height: 999.6 });
    expect(output).toEqual({ width: 4000, height: 1000 });
    expect(output.width * output.height).toBeLessThanOrEqual(4_000_000);
  });
});

describe('isScanWorkerResponse', () => {
  const detection = { center: { x: 50, y: 25 }, size: { width: 100, height: 50 }, rotation: 90 };

  it.each([
    { id: 1, ok: true, type: 'detect', result: detection },
    { id: 2, ok: true, type: 'detect', result: null },
    { id: 3, ok: true, type: 'crop', blob: new Blob(), width: 100, height: 50 },
    { id: 4, ok: false, code: 'opencv-init-failed', message: 'failed' },
    { id: 5, ok: false, code: 'processing-failed', message: 'failed' },
  ])('accepts valid response %#', (response) => {
    expect(isScanWorkerResponse(response)).toBe(true);
  });

  it.each([
    null,
    {},
    { id: Number.NaN, ok: true, type: 'detect', result: null },
    { id: Number.POSITIVE_INFINITY, ok: false, code: 'processing-failed', message: 'failed' },
    { id: 1, ok: true, type: 'detect' },
    { id: 1, ok: true, type: 'detect', result: {} },
    { id: 1, ok: true, type: 'detect', result: { ...detection, rotation: Number.NaN } },
    { id: 1, ok: true, type: 'detect', result: { ...detection, center: { x: Number.POSITIVE_INFINITY, y: 25 } } },
    { id: 1, ok: true, type: 'detect', result: { ...detection, size: { width: 0, height: 50 } } },
    { id: 1, ok: true, type: 'crop', blob: new Blob(), width: 0, height: 50 },
    { id: 1, ok: true, type: 'crop', blob: new Blob(), width: 100, height: Number.NaN },
    { id: 1, ok: true, type: 'crop', blob: {}, width: 100, height: 50 },
    { id: 1, ok: false, code: 'unknown', message: 'failed' },
    { id: 1, ok: false, code: 'processing-failed', message: 123 },
  ])('rejects invalid response %#', (response) => {
    expect(isScanWorkerResponse(response)).toBe(false);
  });
});
