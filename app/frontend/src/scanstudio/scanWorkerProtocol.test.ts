// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import { isScanWorkerResponse, type WorkerCrop, type WorkerDetectionResult } from './scanWorkerProtocol';

describe('scan worker rectangle protocol', () => {
  it('uses detector centre, size and angle without corner payloads', () => {
    const result: WorkerDetectionResult = { center: { x: 50, y: 25 }, size: { width: 100, height: 50 }, rotation: 90 };
    const crop: WorkerCrop = { centerX: result.center.x, centerY: result.center.y, width: result.size.width, height: result.size.height, rotationDegrees: result.rotation };
    expect(crop).not.toHaveProperty('corners');
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
