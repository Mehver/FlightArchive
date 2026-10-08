// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { PaperBoardingPassLayout } from './types';

export class DomainValidationError extends Error {
  constructor(public readonly issues: string[]) { super(issues.join('; ')); this.name = 'DomainValidationError'; }
}
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function assertAllowed(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new DomainValidationError([`${label} contains unsupported fields: ${unknown.sort().join(', ')}`]);
}
export function stringValue(value: unknown, maxLength = 512): string { return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''; }
export function optionalString(value: unknown, maxLength = 512): string | null { return stringValue(value, maxLength) || null; }
export function stringList(value: unknown, maxItems = 64, maxLength = 64): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value.slice(0, maxItems)) { const text = stringValue(item, maxLength); if (text && !result.includes(text)) result.push(text); }
  return result;
}
export function hexColor(value: unknown): `#${string}` | null {
  if (typeof value !== 'string') return null; const normalized = value.toUpperCase();
  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized as `#${string}` : null;
}
export function isSafeResourcePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
export function assertStableResourcePath(value: string | null, label: string): void {
  if (value !== null && (!isSafeResourcePath(value) || value.startsWith('inbox/') || value.startsWith('ignore/'))) throw new DomainValidationError([`${label} must reference a stable safe resource path`]);
}
function finiteBetween(value: unknown, low: number, high: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new DomainValidationError([`${label} must be a finite number in ${low}..${high}`]);
}
export function parsePaperLayout(value: unknown, label: string): PaperBoardingPassLayout {
  if (!isRecord(value)) throw new DomainValidationError([`${label} must be an object`]);
  assertAllowed(value, ['schemaVersion', 'algorithm', 'crop', 'templateId', 'placement'], label);
  if (value.schemaVersion !== 1) throw new DomainValidationError([`${label}.schemaVersion must be 1`]);
  if (!['adaptive', 'canny', 'sobel', 'laplacian'].includes(String(value.algorithm))) throw new DomainValidationError([`${label}.algorithm is invalid`]);
  if (typeof value.templateId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.svg$/.test(value.templateId)) throw new DomainValidationError([`${label}.templateId must be a safe SVG filename`]);
  if (!isRecord(value.crop) || !isRecord(value.placement)) throw new DomainValidationError([`${label} crop and placement must be objects`]);
  assertAllowed(value.crop, ['centerX', 'centerY', 'width', 'height', 'rotationDegrees', 'corners'], `${label}.crop`);
  assertAllowed(value.placement, ['scale', 'rotationDegrees', 'offsetX', 'offsetY'], `${label}.placement`);
  finiteBetween(value.crop.centerX, 0, 1_000_000, `${label}.crop.centerX`); finiteBetween(value.crop.centerY, 0, 1_000_000, `${label}.crop.centerY`);
  finiteBetween(value.crop.width, 0.001, 1_000_000, `${label}.crop.width`); finiteBetween(value.crop.height, 0.001, 1_000_000, `${label}.crop.height`);
  finiteBetween(value.crop.rotationDegrees, -360, 360, `${label}.crop.rotationDegrees`); finiteBetween(value.placement.scale, 0.01, 10, `${label}.placement.scale`);
  finiteBetween(value.placement.rotationDegrees, -360, 360, `${label}.placement.rotationDegrees`); finiteBetween(value.placement.offsetX, -1, 1, `${label}.placement.offsetX`); finiteBetween(value.placement.offsetY, -1, 1, `${label}.placement.offsetY`);
  return value as unknown as PaperBoardingPassLayout;
}
