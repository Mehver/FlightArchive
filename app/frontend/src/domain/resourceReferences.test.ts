// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it } from 'vitest';
import fixture from '../../../test-fixtures/business-data-v1.json';
import { parseBusinessDataV1 } from './schemaV1';
import type { BusinessData, FlightRecord } from './types';
import { applyResourceRetargets, planResourceTransitions, referencesByResource } from './resourceReferences';

const parsed = parseBusinessDataV1(fixture.validDocument);
const empty: BusinessData = { ...parsed, flights: [], airlines: [] };
const flight = (id: string, date = '2030-01-02'): FlightRecord => ({
  ...parsed.flights[0], id, departureDate: date, airlineCode: 'ZX', flightNumber: '7',
  createdAt: id === 'old' ? '' : undefined as unknown as string,
  paperBoardingPassFrontResourcePath: null, paperBoardingPassBackResourcePath: null,
  electronicBoardingPassResourcePath: null, attachmentResourcePaths: [], paperBoardingPassLayouts: {}, electronicBoardingPass: null,
});

describe('resource reference coordination', () => {
  it('scans every direct flight and airline reference', () => {
    const path = 'shared.png';
    const value = flight('one');
    const data = { ...empty, flights: [{ ...value, paperBoardingPassFrontResourcePath: path, attachmentResourcePaths: [path] }], airlines: [{ ...parsed.airlines[0], symbolLogoResourcePath: path }] };
    expect(referencesByResource(data).get(path)?.map((item) => item.location)).toEqual([
      'paperBoardingPassFrontResourcePath', 'attachmentResourcePaths.0', 'symbolLogoResourcePath',
    ]);
  });

  it('creates flat first-binding names for every flight role', () => {
    const next = { ...empty, flights: [{
      ...flight('one'), paperBoardingPassFrontResourcePath: 'inbox/front.JPG', paperBoardingPassBackResourcePath: 'inbox/back.PNG',
      electronicBoardingPassResourcePath: 'inbox/electronic.PDF', attachmentResourcePaths: ['inbox/one.txt', 'inbox/two.bin'],
    }] };
    expect(planResourceTransitions(empty, next)).toEqual([
      { from: 'inbox/front.JPG', to: '20300102zx0007a0.jpg' },
      { from: 'inbox/back.PNG', to: '20300102zx0007a1.png' },
      { from: 'inbox/electronic.PDF', to: '20300102zx0007b0.pdf' },
      { from: 'inbox/one.txt', to: '20300102zx0007c0.txt' },
      { from: 'inbox/two.bin', to: '20300102zx0007c0.bin' },
    ]);
  });

  it('uses flat, role-specific airline logo names', () => {
    const airline = { ...parsed.airlines[0], code: 'ZX', horizontalLogoResourcePath: 'inbox/h.PNG', horizontalDarkLogoResourcePath: 'inbox/d.png', symbolLogoResourcePath: 'inbox/s.SVG' };
    expect(planResourceTransitions(empty, { ...empty, airlines: [airline] })).toEqual([
      { from: 'inbox/h.PNG', to: 'zx-horizontal.png' },
      { from: 'inbox/d.png', to: 'zx-horizontal-dark.png' },
      { from: 'inbox/s.SVG', to: 'zx-symbol.svg' },
    ]);
  });

  it('promotes one shared mapping from attachment through b, a1, and a0 roles', () => {
    const path = '20300201zx0007c0.png';
    const attachment = { ...flight('attachment', '2030-02-01'), attachmentResourcePaths: [path] };
    const electronic = { ...flight('electronic', '2030-01-04'), electronicBoardingPassResourcePath: path };
    const back = { ...flight('back', '2030-01-03'), paperBoardingPassBackResourcePath: path };
    const front = { ...flight('front', '2030-01-02'), paperBoardingPassFrontResourcePath: path };
    let before = { ...empty, flights: [attachment] };
    let after = { ...empty, flights: [attachment, electronic] };
    expect(planResourceTransitions(before, after)).toContainEqual({ from: path, to: '20300104zx0007b0.png' });
    const b = '20300104zx0007b0.png'; before = applyResourceRetargets(after, [{ from: path, to: b }]);
    after = { ...before, flights: [...before.flights, { ...back, paperBoardingPassBackResourcePath: b }] };
    expect(planResourceTransitions(before, after)).toContainEqual({ from: b, to: '20300103zx0007a1.png' });
    const a1 = '20300103zx0007a1.png'; before = applyResourceRetargets(after, [{ from: b, to: a1 }]);
    after = { ...before, flights: [...before.flights, { ...front, paperBoardingPassFrontResourcePath: a1 }] };
    expect(planResourceTransitions(before, after)).toContainEqual({ from: a1, to: '20300102zx0007a0.png' });
  });

  it('retains an equal-priority naming source and selects a remaining owner by business fields', () => {
    const path = '20300201zx0007a0.png';
    const current = { ...flight('z', '2030-02-01'), paperBoardingPassFrontResourcePath: path };
    const earlier = { ...flight('a', '2030-01-01'), paperBoardingPassFrontResourcePath: path };
    const before = { ...empty, flights: [current] }, shared = { ...empty, flights: [current, earlier] };
    expect(planResourceTransitions(before, shared)).toEqual([]);
    expect(planResourceTransitions(shared, { ...empty, flights: [earlier] })).toEqual([{ from: path, to: '20300101zx0007a0.png' }]);
  });

  it.each([
    ['20300201zx0007a2.png', 'paperBoardingPassFrontResourcePath'],
    ['20300201zx0007b1.png', 'electronicBoardingPassResourcePath'],
  ] as const)('keeps the live collision alias %s when an equal-priority sharer is added', (path, slot) => {
    const current = { ...flight('current', '2030-02-01'), [slot]: path };
    const sharer = { ...flight('sharer', '2030-03-01'), [slot]: path };
    expect(planResourceTransitions({ ...empty, flights: [current] }, { ...empty, flights: [current, sharer] })).toEqual([]);
  });

  it('keeps a live c alias for equal attachment sharing but promotes a published hash-suffixed name to a higher role', () => {
    const collision = '20300201zx0007c1.png';
    const current = { ...flight('current', '2030-02-01'), attachmentResourcePaths: [collision] };
    const sharer = { ...flight('sharer', '2030-03-01'), attachmentResourcePaths: [collision] };
    expect(planResourceTransitions({ ...empty, flights: [current] }, { ...empty, flights: [current, sharer] })).toEqual([]);

    const hashed = '20300201zx0007c1-0123456789.jpg';
    const attachment = { ...current, attachmentResourcePaths: [hashed] };
    const front = { ...flight('front', '2030-01-01'), paperBoardingPassFrontResourcePath: hashed };
    expect(planResourceTransitions({ ...empty, flights: [attachment] }, { ...empty, flights: [attachment, front] })).toContainEqual({
      from: hashed, to: '20300101zx0007a0.jpg',
    });
  });

  it('treats airline logo slots as equal priority while using fixed traversal for a first shared binding', () => {
    const symbolPath = 'zx-symbol.svg';
    const symbol = { ...parsed.airlines[0], code: 'ZX', horizontalLogoResourcePath: null, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: symbolPath };
    const shared = { ...symbol, horizontalLogoResourcePath: symbolPath };
    expect(planResourceTransitions({ ...empty, airlines: [symbol] }, { ...empty, airlines: [shared] })).toEqual([]);

    const inbox = 'inbox/shared.svg';
    const first = { ...parsed.airlines[0], code: 'ZX', horizontalLogoResourcePath: inbox, horizontalDarkLogoResourcePath: inbox, symbolLogoResourcePath: inbox };
    expect(planResourceTransitions(empty, { ...empty, airlines: [first] })).toEqual([{ from: inbox, to: 'zx-horizontal.svg' }]);
  });

  it('orders equal natural-name candidates by business identity rather than prospective array order', () => {
    const a = { ...flight('a'), paperBoardingPassFrontResourcePath: 'inbox/source-a.png' };
    const b = { ...flight('b'), paperBoardingPassFrontResourcePath: 'inbox/source-b.png' };
    const forward = planResourceTransitions(empty, { ...empty, flights: [a, b] });
    const reversed = planResourceTransitions(empty, { ...empty, flights: [b, a] });
    expect(forward).toEqual(reversed);
    expect(forward.map((item) => item.from)).toEqual(['inbox/source-a.png', 'inbox/source-b.png']);
  });

  it('renames the current controlling resource before an identity edit is persisted', () => {
    const path = '20300102zx0007a0.png';
    const beforeFlight = { ...flight('one'), paperBoardingPassFrontResourcePath: path };
    const edited = { ...beforeFlight, departureDate: '2031-04-05', airlineCode: 'CA', flightNumber: '88' };
    expect(planResourceTransitions({ ...empty, flights: [beforeFlight] }, { ...empty, flights: [edited] }, new Set(['flight:one']))).toEqual([
      { from: path, to: '20310405ca0088a0.png' },
    ]);
  });

  it('does not migrate arbitrary legacy paths on metadata-only saves', () => {
    const legacy = { ...flight('one'), paperBoardingPassFrontResourcePath: 'legacy/custom.png' };
    expect(planResourceTransitions({ ...empty, flights: [legacy] }, { ...empty, flights: [{ ...legacy, notes: 'changed' }] }, new Set(['flight:one']))).toEqual([]);
  });

  it('does not renumber existing attachment names when their array order changes', () => {
    const first = '20300102zx0007c0.pdf', second = '20300102zx0007c1.pdf';
    const beforeFlight = { ...flight('one'), attachmentResourcePaths: [first, second] };
    const reordered = { ...beforeFlight, attachmentResourcePaths: [second, first] };
    expect(planResourceTransitions({ ...empty, flights: [beforeFlight] }, { ...empty, flights: [reordered] })).toEqual([]);
  });

  it('releases only the final reference and preserves independent crop and extraction data on retarget', () => {
    const path = '20300102zx0007a0.png';
    const original = { ...flight('one'), paperBoardingPassFrontResourcePath: path, paperBoardingPassBackResourcePath: path,
      paperBoardingPassLayouts: parsed.flights[0].paperBoardingPassLayouts, electronicBoardingPass: parsed.flights[0].electronicBoardingPass };
    const oneLeft = { ...original, paperBoardingPassBackResourcePath: null };
    expect(planResourceTransitions({ ...empty, flights: [original] }, { ...empty, flights: [oneLeft] }).some((item) => item.to === null)).toBe(false);
    const renamed = applyResourceRetargets({ ...empty, flights: [original] }, [{ from: path, to: '20300102zx0007a2.png' }]);
    expect(renamed.flights[0].paperBoardingPassLayouts).toEqual(original.paperBoardingPassLayouts);
    expect(renamed.flights[0].electronicBoardingPass).toEqual(original.electronicBoardingPass);
  });
});
