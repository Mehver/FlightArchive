// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import type { WorkerCrop, WorkerDetectionResult } from './scanWorkerProtocol';

describe('scan worker rectangle protocol', () => {
  it('uses detector centre, size and angle without corner payloads', () => {
    const result: WorkerDetectionResult = { center: { x: 50, y: 25 }, size: { width: 100, height: 50 }, rotation: 90 };
    const crop: WorkerCrop = { centerX: result.center.x, centerY: result.center.y, width: result.size.width, height: result.size.height, rotationDegrees: result.rotation };
    expect(crop).not.toHaveProperty('corners');
  });
});
