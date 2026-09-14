// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Pure resource-to-business-reference index shared by mapping views. */
import type { Airline, FlightRecord } from '../api/types';

export type FlightResourceRole =
  | 'paperBoardingPassFront'
  | 'paperBoardingPassBack'
  | 'electronicBoardingPass'
  | 'attachment';
export type AirlineResourceRole = 'horizontalLogo' | 'horizontalDarkLogo' | 'symbolLogo';
export type ResourceUsageRole = FlightResourceRole | AirlineResourceRole;
/** Translation-key suffixes for usage roles. Kept here with the data model so
 * consumers cannot derive keys from role strings ad hoc. */
export type ResourceUsageRoleKey =
  | 'usageRolePaperBoardingPassFront'
  | 'usageRolePaperBoardingPassBack'
  | 'usageRoleElectronicBoardingPass'
  | 'usageRoleAttachment'
  | 'usageRoleHorizontalLogo'
  | 'usageRoleHorizontalDarkLogo'
  | 'usageRoleSymbolLogo';
type FlightResourceField = 'paperBoardingPassFrontResourcePath' | 'paperBoardingPassBackResourcePath' | 'electronicBoardingPassResourcePath';
type AirlineResourceField = 'horizontalLogoResourcePath' | 'horizontalDarkLogoResourcePath' | 'symbolLogoResourcePath';

export type ResourceUse =
  | { kind: 'flight'; flight: FlightRecord; role: FlightResourceRole }
  | { kind: 'airline'; airline: Airline; role: AirlineResourceRole };

const usageRoleKeys: Record<ResourceUsageRole, ResourceUsageRoleKey> = {
  paperBoardingPassFront: 'usageRolePaperBoardingPassFront',
  paperBoardingPassBack: 'usageRolePaperBoardingPassBack',
  electronicBoardingPass: 'usageRoleElectronicBoardingPass',
  attachment: 'usageRoleAttachment',
  horizontalLogo: 'usageRoleHorizontalLogo',
  horizontalDarkLogo: 'usageRoleHorizontalDarkLogo',
  symbolLogo: 'usageRoleSymbolLogo',
};

/** Return the stable presentation key for a persisted resource role. */
export function usageRoleKey(role: ResourceUsageRole): ResourceUsageRoleKey {
  return usageRoleKeys[role];
}

const flightSlots: readonly [FlightResourceField, FlightResourceRole][] = [
  ['paperBoardingPassFrontResourcePath', 'paperBoardingPassFront'],
  ['paperBoardingPassBackResourcePath', 'paperBoardingPassBack'],
  ['electronicBoardingPassResourcePath', 'electronicBoardingPass'],
];
const airlineSlots: readonly [AirlineResourceField, AirlineResourceRole][] = [
  ['horizontalLogoResourcePath', 'horizontalLogo'],
  ['horizontalDarkLogoResourcePath', 'horizontalDarkLogo'],
  ['symbolLogoResourcePath', 'symbolLogo'],
];

/** Index every persisted flight and airline slot by its selected virtual path. */
export function resourceUsageIndex(flights: readonly FlightRecord[], airlines: readonly Airline[]): Map<string, ResourceUse[]> {
  const uses = new Map<string, ResourceUse[]>();
  const add = (path: string | null, use: ResourceUse) => {
    if (!path) return;
    const existing = uses.get(path);
    if (existing) existing.push(use);
    else uses.set(path, [use]);
  };
  for (const flight of flights) {
    for (const [field, role] of flightSlots) add(flight[field], { kind: 'flight', flight, role });
    for (const path of flight.attachmentResourcePaths) add(path, { kind: 'flight', flight, role: 'attachment' });
  }
  for (const airline of airlines) {
    for (const [field, role] of airlineSlots) add(airline[field], { kind: 'airline', airline, role });
  }
  return uses;
}

export function usageForPath(index: ReadonlyMap<string, ResourceUse[]>, virtualPath: string | null): readonly ResourceUse[] {
  return virtualPath ? index.get(virtualPath) ?? [] : [];
}

/** Count the distinct business records that reference a resource.
 * Individual uses remain available for role-level presentation. */
export function resourceUsageCounts(uses: readonly ResourceUse[]): { flights: number; airlines: number } {
  const flights = new Set<string>();
  const airlines = new Set<string>();
  for (const use of uses) {
    if (use.kind === 'flight') flights.add(use.flight.id);
    else airlines.add(use.airline.code);
  }
  return { flights: flights.size, airlines: airlines.size };
}
