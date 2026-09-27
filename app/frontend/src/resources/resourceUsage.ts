// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Presentation-only helpers for usage records already joined by the backend. */
import type { ResourceUse } from '../api/types';

export type ResourceUsageRole = ResourceUse['role'];
export type ResourceUsageRoleKey =
  | 'usageRolePaperBoardingPassFront' | 'usageRolePaperBoardingPassBack'
  | 'usageRoleElectronicBoardingPass' | 'usageRoleAttachment'
  | 'usageRoleHorizontalLogo' | 'usageRoleHorizontalDarkLogo' | 'usageRoleSymbolLogo';

const keys: Record<ResourceUsageRole, ResourceUsageRoleKey> = {
  paperBoardingPassFront: 'usageRolePaperBoardingPassFront', paperBoardingPassBack: 'usageRolePaperBoardingPassBack',
  electronicBoardingPass: 'usageRoleElectronicBoardingPass', attachment: 'usageRoleAttachment',
  horizontal: 'usageRoleHorizontalLogo', 'horizontal-dark': 'usageRoleHorizontalDarkLogo', symbol: 'usageRoleSymbolLogo',
};

export function usageRoleKey(role: ResourceUsageRole | string): ResourceUsageRoleKey {
  return keys[role as ResourceUsageRole] ?? 'usageRoleAttachment';
}

export function resourceUsageCounts(uses: readonly ResourceUse[]): { flights: number; airlines: number } {
  return {
    flights: new Set(uses.flatMap((use) => use.kind === 'flight' ? [use.id] : [])).size,
    airlines: new Set(uses.flatMap((use) => use.kind === 'airline' ? [use.code] : [])).size,
  };
}
