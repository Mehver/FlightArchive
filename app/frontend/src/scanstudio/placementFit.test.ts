// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import { calculateAutoFit } from './placementFit';

describe('calculateAutoFit', () => {
  const template = { width: 247, height: 100 };

  describe('long edge fit', () => {
    it('fills template width when crop is wider than template', () => {
      const crop = { width: 500, height: 100 }; // aspect 5.0 > tpl aspect 2.47
      const result = calculateAutoFit(crop, template, 'long', 'center');
      expect(result.w).toBe(247);
      expect(result.h).toBeCloseTo(247 / 5.0);
      expect(result.cx).toBeCloseTo(247 / 2);
      expect(result.cy).toBeCloseTo(100 / 2);
    });

    it('fills template height when crop is taller than template', () => {
      const crop = { width: 200, height: 400 }; // aspect 0.5 < tpl aspect 2.47
      const result = calculateAutoFit(crop, template, 'long', 'center');
      expect(result.h).toBe(100);
      expect(result.w).toBeCloseTo(100 * 0.5);
      expect(result.cx).toBeCloseTo(247 / 2);
      expect(result.cy).toBeCloseTo(100 / 2);
    });

    it('aligns to left edge when alignment is left', () => {
      const crop = { width: 400, height: 200 };
      const result = calculateAutoFit(crop, template, 'long', 'left');
      expect(result.cx).toBeCloseTo(result.w / 2);
    });

    it('aligns to right edge when alignment is right', () => {
      const crop = { width: 400, height: 200 };
      const result = calculateAutoFit(crop, template, 'long', 'right');
      expect(result.cx).toBeCloseTo(template.width - result.w / 2);
    });
  });

  describe('short edge fit', () => {
    it('fills template height when crop is wider than template', () => {
      const crop = { width: 500, height: 100 }; // aspect 5.0 > tpl aspect 2.47
      const result = calculateAutoFit(crop, template, 'short', 'center');
      expect(result.h).toBe(100);
      expect(result.w).toBeCloseTo(100 * 5.0);
      expect(result.cx).toBeCloseTo(247 / 2);
      expect(result.cy).toBeCloseTo(100 / 2);
    });

    it('fills template width when crop is taller than template', () => {
      const crop = { width: 200, height: 400 }; // aspect 0.5 < tpl aspect 2.47
      const result = calculateAutoFit(crop, template, 'short', 'center');
      expect(result.w).toBe(247);
      expect(result.h).toBeCloseTo(247 / 0.5);
      expect(result.cx).toBeCloseTo(247 / 2);
      expect(result.cy).toBeCloseTo(100 / 2);
    });

    it('aligns to left edge when alignment is left', () => {
      const crop = { width: 400, height: 200 };
      const result = calculateAutoFit(crop, template, 'short', 'left');
      expect(result.cx).toBeCloseTo(result.w / 2);
    });

    it('aligns to right edge when alignment is right', () => {
      const crop = { width: 400, height: 200 };
      const result = calculateAutoFit(crop, template, 'short', 'right');
      expect(result.cx).toBeCloseTo(template.width - result.w / 2);
    });
  });

  describe('edge alignment', () => {
    it('left alignment has zero gap to left edge', () => {
      const crop = { width: 400, height: 200 };
      const result = calculateAutoFit(crop, template, 'long', 'left');
      const leftEdge = result.cx - result.w / 2;
      expect(leftEdge).toBeCloseTo(0);
    });

    it('right alignment has zero gap to right edge', () => {
      const crop = { width: 400, height: 200 };
      const result = calculateAutoFit(crop, template, 'long', 'right');
      const rightEdge = result.cx + result.w / 2;
      expect(rightEdge).toBeCloseTo(template.width);
    });

    it('center alignment is centered', () => {
      const crop = { width: 400, height: 200 };
      const result = calculateAutoFit(crop, template, 'long', 'center');
      expect(result.cx).toBeCloseTo(template.width / 2);
    });
  });

  describe('no scaling factor', () => {
    it('long edge fit uses 100% not 70%', () => {
      const crop = { width: 400, height: 200 };
      const result = calculateAutoFit(crop, template, 'long', 'center');
      // One dimension should exactly match template
      const widthMatches = result.w === template.width;
      const heightMatches = result.h === template.height;
      expect(widthMatches || heightMatches).toBe(true);
    });

    it('short edge fit uses 100% not 70%', () => {
      const crop = { width: 400, height: 200 };
      const result = calculateAutoFit(crop, template, 'short', 'center');
      // One dimension should exactly match template
      const widthMatches = result.w === template.width;
      const heightMatches = result.h === template.height;
      expect(widthMatches || heightMatches).toBe(true);
    });
  });
});
