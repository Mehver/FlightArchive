// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause
import { describe, expect, it } from 'vitest';
import type { Airline, FlightRecord } from '../api/types';
import { resourceUsageCounts, resourceUsageIndex, usageRoleKey } from './resourceUsage';

const flight = {
  id: 'f1', flightNumber: 'SF12', departureDate: '2026-01-02',
  paperBoardingPassFrontResourcePath: 'objects/front.png',
  paperBoardingPassBackResourcePath: 'objects/back.png',
  electronicBoardingPassResourcePath: 'objects/electronic.png',
  attachmentResourcePaths: ['objects/front.png', 'objects/attachment.pdf'],
} as FlightRecord;
const airline = { code: 'SF', horizontalLogoResourcePath: 'objects/front.png', horizontalDarkLogoResourcePath: 'objects/horizontal-dark.png', symbolLogoResourcePath: 'objects/symbol.png' } as Airline;

describe('resourceUsageIndex', () => {
  it('indexes all flight slots, attachments, and airline logo slots', () => {
    const usage = resourceUsageIndex([flight], [airline]);
    expect(usage.get('objects/front.png')?.map((use) => `${use.kind}:${use.role}`)).toEqual(['flight:paperBoardingPassFront', 'flight:attachment', 'airline:horizontalLogo']);
    expect(usage.get('objects/back.png')?.[0].role).toBe('paperBoardingPassBack');
    expect(usage.get('objects/electronic.png')?.[0].role).toBe('electronicBoardingPass');
    expect(usage.get('objects/attachment.pdf')?.[0].role).toBe('attachment');
    expect(usage.get('objects/symbol.png')?.[0].role).toBe('symbolLogo');
    expect(usage.get('objects/horizontal-dark.png')?.[0].role).toBe('horizontalDarkLogo');
  });

  it('maps every resource role to its explicit translation key', () => {
    expect(usageRoleKey('paperBoardingPassFront')).toBe('usageRolePaperBoardingPassFront');
    expect(usageRoleKey('attachment')).toBe('usageRoleAttachment');
    expect(usageRoleKey('symbolLogo')).toBe('usageRoleSymbolLogo');
    expect(usageRoleKey('horizontalDarkLogo')).toBe('usageRoleHorizontalDarkLogo');
  });

  it('counts unique flight IDs and airline codes while preserving every role use', () => {
    const secondFlight = { ...flight, id: 'f2', attachmentResourcePaths: ['objects/front.png'] };
    const duplicateAirline = { ...airline, horizontalLogoResourcePath: null, symbolLogoResourcePath: 'objects/front.png' };
    const uses = resourceUsageIndex([flight, secondFlight], [airline, duplicateAirline]).get('objects/front.png')!;

    expect(uses).toHaveLength(6);
    expect(resourceUsageCounts(uses)).toEqual({ flights: 2, airlines: 1 });
  });
});
