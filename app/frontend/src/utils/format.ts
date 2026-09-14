// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Small formatting helpers shared across pages. */

type Translate = (key: 'formatBytes' | 'notAvailable', params?: { value: string | number; unit: string }) => string;

export function formatBytes(size: number, t: Translate): string {
  if (!Number.isFinite(size) || size < 0) return t('notAvailable');
  if (size < 1024) return t('formatBytes', { value: size, unit: 'B' });
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = size;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return t('formatBytes', { value: value.toFixed(value >= 100 ? 0 : 1), unit: units[unit] });
}

export function displayName(zh: string, en: string, notAvailable: string): string {
  if (zh && en && zh !== en) return `${zh} · ${en}`;
  return zh || en || notAvailable;
}

export function displayFlightNumber(airlineCode: string, flightNumber: string): string {
  return `${airlineCode}${flightNumber}`;
}

/**
 * Concise bilingual "unlisted reference" note. Flight records may carry
 * valid airline/airport/aircraft codes that are not catalogued in the
 * flight reference data; wherever a catalogued name would be shown, the
 * stored code is kept verbatim and this note marks the missing metadata.
 * The string is intentionally bilingual (like `displayName` output) so the
 * fallback reads the same in both UI languages.
 */
export const UNLISTED_REFERENCE_NOTE = '未收录 · Unlisted';

export function unlistedCodeLabel(code: string): string {
  return `${code} · ${UNLISTED_REFERENCE_NOTE}`;
}
