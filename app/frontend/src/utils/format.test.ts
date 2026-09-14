// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Display contract for valid-but-uncatalogued airline/airport/aircraft
 * codes: the stored code is always kept verbatim and a concise bilingual
 * "unlisted reference" note marks the missing metadata — never blank,
 * never just the bare code where a catalogued name is expected.
 */

import { describe, expect, it } from 'vitest';
import { UNLISTED_REFERENCE_NOTE, displayFlightNumber, displayName, unlistedCodeLabel } from './format';

describe('unlistedCodeLabel', () => {
  it('keeps the stored code verbatim', () => {
    expect(unlistedCodeLabel('ZZ')).toMatch(/^ZZ /);
    expect(unlistedCodeLabel('ZZ')).toContain('ZZ');
  });

  it('appends a concise bilingual unlisted-reference note', () => {
    const label = unlistedCodeLabel('9H');
    expect(label).toBe('9H · 未收录 · Unlisted');
    expect(label).toContain('未收录');
    expect(label).toContain('Unlisted');
  });

  it('shares one bilingual note constant', () => {
    expect(UNLISTED_REFERENCE_NOTE).toBe('未收录 · Unlisted');
  });
});

describe('displayName / displayFlightNumber (unchanged neighbours)', () => {
  it('joins differing bilingual names, otherwise keeps whichever exists', () => {
    expect(displayName('北京', 'Beijing', '—')).toBe('北京 · Beijing');
    expect(displayName('', 'Beijing', '—')).toBe('Beijing');
    expect(displayName('', '', '—')).toBe('—');
  });

  it('concatenates airline code and flight number', () => {
    expect(displayFlightNumber('CA', '1234')).toBe('CA1234');
  });
});
