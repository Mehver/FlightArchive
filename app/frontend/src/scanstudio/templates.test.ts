// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import { BOARDING_PASS_TEMPLATES, templateById, templatesForSide } from './templates';

describe('boarding-pass templates', () => {
  it('keeps front and back catalogs separate with simplified IDs', () => {
    const front = templatesForSide('front');
    const back = templatesForSide('back');

    expect(front).toHaveLength(11);
    expect(back).toHaveLength(11);
    expect(front.every((template) => template.side === 'front')).toBe(true);
    expect(back.every((template) => template.side === 'back')).toBe(true);
    expect(BOARDING_PASS_TEMPLATES.every((template) => !template.id.startsWith('bp-100-'))).toBe(true);
  });

  it('reverses split widths and IDs for back templates', () => {
    expect(templateById('bp-179-068.svg', 'front').segments).toEqual([179, 68]);
    expect(templateById('bp-068-179.svg', 'back').segments).toEqual([68, 179]);
    expect(templateById('bp-034-034-160-019.svg', 'back').segments).toEqual([34, 34, 160, 19]);
  });

  it('resolves identical no-split IDs within the requested side', () => {
    expect(templateById('bp-247.svg', 'front').side).toBe('front');
    expect(templateById('bp-247.svg', 'back').side).toBe('back');
  });

  it('does not resolve a template from the opposite side', () => {
    expect(templateById('bp-068-179.svg', 'front').id).toBe('bp-247.svg');
    expect(templateById('bp-179-068.svg', 'back').id).toBe('bp-247.svg');
  });
});
