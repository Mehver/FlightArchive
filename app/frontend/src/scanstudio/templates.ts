// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// Static boarding-pass templates preserve the reference demo's black,
// alternating hatch design. Numeric ID segments are physical section widths;
// back-side IDs and artwork reverse those widths from the front.

import bp247FrontUrl from './templates/front/bp-247.svg';
import bp179068Url from './templates/front/bp-179-068.svg';
import bp175036036Url from './templates/front/bp-175-036-036.svg';
import bp171076Url from './templates/front/bp-171-076.svg';
import bp171038038Url from './templates/front/bp-171-038-038.svg';
import bp036171040Url from './templates/front/bp-036-171-040.svg';
import bp019228Url from './templates/front/bp-019-228.svg';
import bp019160068Url from './templates/front/bp-019-160-068.svg';
import bp019160034034Url from './templates/front/bp-019-160-034-034.svg';
import bp017230Url from './templates/front/bp-017-230.svg';
import bp017160070Url from './templates/front/bp-017-160-070.svg';
import bp247BackUrl from './templates/back/bp-247.svg';
import bp068179Url from './templates/back/bp-068-179.svg';
import bp036036175Url from './templates/back/bp-036-036-175.svg';
import bp076171Url from './templates/back/bp-076-171.svg';
import bp038038171Url from './templates/back/bp-038-038-171.svg';
import bp040171036Url from './templates/back/bp-040-171-036.svg';
import bp228019Url from './templates/back/bp-228-019.svg';
import bp068160019Url from './templates/back/bp-068-160-019.svg';
import bp034034160019Url from './templates/back/bp-034-034-160-019.svg';
import bp230017Url from './templates/back/bp-230-017.svg';
import bp070160017Url from './templates/back/bp-070-160-017.svg';

export type BoardingPassSide = 'front' | 'back';

export interface BoardingPassTemplate {
  /** Persisted as PaperBoardingPassLayout.templateId. */
  id: string;
  url: string;
  width: number;
  height: number;
  /** Physical section widths in template coordinates (display only). */
  segments: number[];
  side: BoardingPassSide;
}

type TemplateDefinition = Pick<BoardingPassTemplate, 'id' | 'url' | 'segments'>;

const FRONT_TEMPLATES: TemplateDefinition[] = [
  { id: 'bp-247.svg', url: bp247FrontUrl, segments: [247] },
  { id: 'bp-179-068.svg', url: bp179068Url, segments: [179, 68] },
  { id: 'bp-175-036-036.svg', url: bp175036036Url, segments: [175, 36, 36] },
  { id: 'bp-171-076.svg', url: bp171076Url, segments: [171, 76] },
  { id: 'bp-171-038-038.svg', url: bp171038038Url, segments: [171, 38, 38] },
  { id: 'bp-036-171-040.svg', url: bp036171040Url, segments: [36, 171, 40] },
  { id: 'bp-019-228.svg', url: bp019228Url, segments: [19, 228] },
  { id: 'bp-019-160-068.svg', url: bp019160068Url, segments: [19, 160, 68] },
  { id: 'bp-019-160-034-034.svg', url: bp019160034034Url, segments: [19, 160, 34, 34] },
  { id: 'bp-017-230.svg', url: bp017230Url, segments: [17, 230] },
  { id: 'bp-017-160-070.svg', url: bp017160070Url, segments: [17, 160, 70] },
];

const BACK_TEMPLATES: TemplateDefinition[] = [
  { id: 'bp-247.svg', url: bp247BackUrl, segments: [247] },
  { id: 'bp-068-179.svg', url: bp068179Url, segments: [68, 179] },
  { id: 'bp-036-036-175.svg', url: bp036036175Url, segments: [36, 36, 175] },
  { id: 'bp-076-171.svg', url: bp076171Url, segments: [76, 171] },
  { id: 'bp-038-038-171.svg', url: bp038038171Url, segments: [38, 38, 171] },
  { id: 'bp-040-171-036.svg', url: bp040171036Url, segments: [40, 171, 36] },
  { id: 'bp-228-019.svg', url: bp228019Url, segments: [228, 19] },
  { id: 'bp-068-160-019.svg', url: bp068160019Url, segments: [68, 160, 19] },
  { id: 'bp-034-034-160-019.svg', url: bp034034160019Url, segments: [34, 34, 160, 19] },
  { id: 'bp-230-017.svg', url: bp230017Url, segments: [230, 17] },
  { id: 'bp-070-160-017.svg', url: bp070160017Url, segments: [70, 160, 17] },
];

function withSide(definition: TemplateDefinition, side: BoardingPassSide): BoardingPassTemplate {
  return { ...definition, width: 247, height: 100, side };
}

export const BOARDING_PASS_TEMPLATES: BoardingPassTemplate[] = [
  ...FRONT_TEMPLATES.map((template) => withSide(template, 'front')),
  ...BACK_TEMPLATES.map((template) => withSide(template, 'back')),
];

export function templatesForSide(side: BoardingPassSide): BoardingPassTemplate[] {
  return BOARDING_PASS_TEMPLATES.filter((template) => template.side === side);
}

export function templateById(id: string | null | undefined, side: BoardingPassSide): BoardingPassTemplate {
  const sideTemplates = templatesForSide(side);
  return sideTemplates.find((template) => template.id === id) ?? sideTemplates[0];
}
