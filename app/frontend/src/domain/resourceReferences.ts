// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { Airline, BusinessData, FlightRecord } from './types';

export type ResourceOwner =
  | { kind: 'flight'; id: string; flight: FlightRecord }
  | { kind: 'airline'; id: string; airline: Airline };

export interface ResourceReference { path: string; owner: ResourceOwner; location: string }
export interface ResourceTransition { from: string; to: string | null }

const FLIGHT_SLOTS = [
  'paperBoardingPassFrontResourcePath',
  'paperBoardingPassBackResourcePath',
  'electronicBoardingPassResourcePath',
] as const;
const AIRLINE_SLOTS = [
  'horizontalLogoResourcePath',
  'horizontalDarkLogoResourcePath',
  'symbolLogoResourcePath',
] as const;

function ownerKey(owner: ResourceOwner): string { return `${owner.kind}:${owner.id}`; }

export function resourceReferences(data: BusinessData): ResourceReference[] {
  const result: ResourceReference[] = [];
  for (const flight of data.flights) {
    const owner: ResourceOwner = { kind: 'flight', id: flight.id, flight };
    for (const slot of FLIGHT_SLOTS) {
      const path = flight[slot];
      if (path) result.push({ path, owner, location: slot });
    }
    flight.attachmentResourcePaths.forEach((path, index) => result.push({ path, owner, location: `attachmentResourcePaths.${index}` }));
  }
  for (const airline of data.airlines) {
    const owner: ResourceOwner = { kind: 'airline', id: airline.code, airline };
    for (const slot of AIRLINE_SLOTS) {
      const path = airline[slot];
      if (path) result.push({ path, owner, location: slot });
    }
  }
  return result;
}

export function referencesByResource(data: BusinessData): Map<string, ResourceReference[]> {
  const result = new Map<string, ResourceReference[]>();
  for (const reference of resourceReferences(data)) {
    const values = result.get(reference.path) ?? [];
    values.push(reference);
    result.set(reference.path, values);
  }
  return result;
}

function extension(path: string): string {
  const name = path.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function compact(value: unknown, fallback: string): string {
  const result = typeof value === 'string' ? value.normalize('NFKC').replace(/[^A-Za-z0-9]/g, '').toLowerCase() : '';
  return result || fallback;
}

function flightStem(flight: FlightRecord): string {
  const date = compact(flight.departureDate, '00000000');
  const airline = compact(flight.airlineCode, 'xx');
  const number = compact(flight.flightNumber, '0').padStart(4, '0');
  return `${date}${airline}${number}`;
}

function role(reference: ResourceReference): string {
  switch (reference.location) {
    case 'paperBoardingPassFrontResourcePath': return 'a0';
    case 'paperBoardingPassBackResourcePath': return 'a1';
    case 'electronicBoardingPassResourcePath': return 'b0';
    case 'horizontalLogoResourcePath': return 'horizontal';
    case 'horizontalDarkLogoResourcePath': return 'horizontal-dark';
    case 'symbolLogoResourcePath': return 'symbol';
    default: return 'c0';
  }
}

function desiredPath(reference: ResourceReference, sourcePath: string): string {
  const ext = extension(sourcePath);
  if (reference.owner.kind === 'flight') return `${flightStem(reference.owner.flight)}${role(reference)}${ext}`;
  return `${compact(reference.owner.airline.code, 'xx')}-${role(reference)}${ext}`;
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** True only for a flat name that can actually have been produced for this reference. */
function nameMatchesReference(path: string, reference: ResourceReference): boolean {
  if (path.includes('/')) return false;
  const ext = extension(path);
  if (reference.owner.kind === 'airline') {
    const base = desiredPath(reference, path).slice(0, -ext.length || undefined);
    return new RegExp(`^${escapeRegex(base)}(?:-(?:[1-9][0-9]*|[0-9a-f]{10}))?${escapeRegex(ext)}$`, 'i').test(path);
  }
  const stem = escapeRegex(flightStem(reference.owner.flight));
  const suffix = reference.location === 'paperBoardingPassFrontResourcePath' ? 'a(?:0|[0-9]*[02468])'
    : reference.location === 'paperBoardingPassBackResourcePath' ? 'a[0-9]*[13579]'
    : reference.location === 'electronicBoardingPassResourcePath' ? 'b[0-9]+'
    : 'c[0-9]+';
  return new RegExp(`^${stem}${suffix}(?:-[0-9a-f]{10})?${escapeRegex(ext)}$`, 'i').test(path);
}

function referenceKey(reference: ResourceReference): string {
  const location = reference.location.startsWith('attachmentResourcePaths.') ? 'attachmentResourcePaths' : reference.location;
  return `${ownerKey(reference.owner)}:${location}`;
}

function referencePriority(reference: ResourceReference): number {
  // Airline logo categories retain their established precedence and are not
  // folded into the flight a/b/c role ordering.
  if (reference.owner.kind === 'airline') return 0;
  if (reference.location === 'paperBoardingPassFrontResourcePath') return 10;
  if (reference.location === 'paperBoardingPassBackResourcePath') return 11;
  if (reference.location === 'electronicBoardingPassResourcePath') return 12;
  return 13;
}

function locationOrdinal(reference: ResourceReference): number {
  if (reference.owner.kind === 'airline') {
    const index = AIRLINE_SLOTS.indexOf(reference.location as typeof AIRLINE_SLOTS[number]);
    return index < 0 ? AIRLINE_SLOTS.length : index;
  }
  const fixed = FLIGHT_SLOTS.indexOf(reference.location as typeof FLIGHT_SLOTS[number]);
  if (fixed >= 0) return fixed;
  const attachment = /^attachmentResourcePaths\.([0-9]+)$/.exec(reference.location);
  return FLIGHT_SLOTS.length + (attachment ? Number(attachment[1]) : Number.MAX_SAFE_INTEGER);
}

function compareReferences(left: ResourceReference, right: ResourceReference): number {
  const priority = referencePriority(left) - referencePriority(right);
  if (priority) return priority;
  if (left.owner.kind === 'flight' && right.owner.kind === 'flight') {
    const fields: Array<[unknown, unknown]> = [
      [left.owner.flight.departureDate, right.owner.flight.departureDate],
      [left.owner.flight.airlineCode, right.owner.flight.airlineCode],
      [left.owner.flight.flightNumber, right.owner.flight.flightNumber],
      [left.owner.id, right.owner.id],
    ];
    for (const [a, b] of fields) {
      const compared = String(a ?? '').localeCompare(String(b ?? ''));
      if (compared) return compared;
    }
  }
  return ownerKey(left.owner).localeCompare(ownerKey(right.owner))
    || locationOrdinal(left) - locationOrdinal(right)
    || left.location.localeCompare(right.location);
}

function controllingReference(path: string, references: readonly ResourceReference[]): ResourceReference | null {
  return [...references].sort(compareReferences).find((reference) => nameMatchesReference(path, reference)) ?? null;
}

/** Plans only resources affected by this explicit CRUD operation. */
export function planResourceTransitions(
  before: BusinessData,
  prospective: BusinessData,
  touchedOwners: ReadonlySet<string> = new Set(),
): ResourceTransition[] {
  const oldGroups = referencesByResource(before), nextGroups = referencesByResource(prospective);
  const candidates = new Set<string>();
  for (const path of new Set([...oldGroups.keys(), ...nextGroups.keys()])) {
    const oldRefs = oldGroups.get(path) ?? [], nextRefs = nextGroups.get(path) ?? [];
    const oldKeys = oldRefs.map(referenceKey).sort().join('|');
    const nextKeys = nextRefs.map(referenceKey).sort().join('|');
    if (oldKeys !== nextKeys) { candidates.add(path); continue; }
    const controller = controllingReference(path, oldRefs);
    if (controller && touchedOwners.has(ownerKey(controller.owner))) {
      const current = nextRefs.find((reference) => referenceKey(reference) === referenceKey(controller));
      if (current && desiredPath(current, path) !== path && !nameMatchesReference(path, current)) candidates.add(path);
    }
  }

  const planned: Array<{ transition: ResourceTransition; reference: ResourceReference | null }> = [];
  for (const path of candidates) {
    const oldRefs = oldGroups.get(path) ?? [], nextRefs = nextGroups.get(path) ?? [];
    if (!nextRefs.length) { planned.push({ transition: { from: path, to: null }, reference: controllingReference(path, oldRefs) }); continue; }
    const ordered = [...nextRefs].sort(compareReferences);
    const oldController = controllingReference(path, oldRefs);
    const retainedController = oldController && ordered.find((reference) => referenceKey(reference) === referenceKey(oldController));
    // Retain the current name only while its naming reference remains in the
    // highest live role. Equal-priority sharers do not make names drift.
    const controller = retainedController && referencePriority(retainedController) === referencePriority(ordered[0])
      ? retainedController : ordered[0];
    const wasManaged = oldController !== null;
    const firstBinding = path.startsWith('inbox/');
    if (!wasManaged && !firstBinding) continue;
    if (retainedController === controller && nameMatchesReference(path, controller)) continue;
    const target = desiredPath(controller, path);
    if (target !== path) planned.push({ transition: { from: path, to: target }, reference: controller });
  }
  return planned.sort((left, right) => {
    if (left.reference && right.reference) return compareReferences(left.reference, right.reference) || left.transition.from.localeCompare(right.transition.from);
    if (left.reference) return -1;
    if (right.reference) return 1;
    return left.transition.from.localeCompare(right.transition.from);
  }).map(({ transition }) => transition);
}

/** Retargets a virtual same-source alias rename without treating it as a new binding. */
export function retargetResource(data: BusinessData, from: string, to: string): BusinessData {
  const flights = data.flights.map((flight) => {
    let changed = false;
    const next = { ...flight, paperBoardingPassLayouts: flight.paperBoardingPassLayouts, electronicBoardingPass: flight.electronicBoardingPass };
    for (const slot of FLIGHT_SLOTS) if (next[slot] === from) { next[slot] = to; changed = true; }
    const attachments = flight.attachmentResourcePaths.map((path) => path === from ? to : path);
    if (attachments.some((path, index) => path !== flight.attachmentResourcePaths[index])) { next.attachmentResourcePaths = attachments; changed = true; }
    return changed ? next : flight;
  });
  const airlines = data.airlines.map((airline) => {
    let changed = false; const next = { ...airline };
    for (const slot of AIRLINE_SLOTS) if (next[slot] === from) { next[slot] = to; changed = true; }
    return changed ? next : airline;
  });
  return { ...data, flights, airlines };
}

export function applyResourceRetargets(data: BusinessData, transitions: readonly ResourceTransition[]): BusinessData {
  return transitions.reduce((current, transition) => transition.to ? retargetResource(current, transition.from, transition.to) : current, data);
}
