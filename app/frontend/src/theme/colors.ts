// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { Airline, FlightRecord, HexColor } from '../api/types';
import { alpha } from '@mui/material/styles';

export type { HexColor } from '../api/types';

/** Internal sRGB triple used for pixel-level math (luminance, blending). */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface FlightVisualTheme {
  airlinePrimary: HexColor | null;
  airlineContrast: HexColor | null;
  flightColor: HexColor | null;
}

const DARK_SURFACE = '#1e1e1e';
const LIGHT_SURFACE = '#ffffff';
const TRANSPARENT = 'transparent';
const BLACK_LUMINANCE_CUTOFF = 0.179;

const HEX_COLOR_RE = /^#[0-9A-F]{6}$/;

/** Return whether a value is a well-formed 6-digit uppercase hex colour. */
export function isValidHexColor(color: unknown): color is HexColor {
  return typeof color === 'string' && HEX_COLOR_RE.test(color);
}

/** Parse a hex colour into an sRGB triple. Returns null for invalid input. */
export function hexToRgb(color: HexColor | string): RgbColor | null {
  if (!HEX_COLOR_RE.test(color)) return null;
  return {
    r: Number.parseInt(color.slice(1, 3), 16),
    g: Number.parseInt(color.slice(3, 5), 16),
    b: Number.parseInt(color.slice(5, 7), 16),
  };
}

/** Format an sRGB triple as an uppercase 6-digit hex colour. */
export function rgbToHex(color: RgbColor): HexColor {
  const clamp = (channel: number) => Math.max(0, Math.min(255, Math.round(channel)));
  return `#${clamp(color.r).toString(16).padStart(2, '0').toUpperCase()}${clamp(color.g).toString(16).padStart(2, '0').toUpperCase()}${clamp(color.b).toString(16).padStart(2, '0').toUpperCase()}` as HexColor;
}

/** Render a hex colour as a CSS ``rgb(...)`` string. */
export function hexToCss(color: HexColor): string {
  const rgb = hexToRgb(color);
  return rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : TRANSPARENT;
}

/** Calculate WCAG relative luminance for a hex colour. */
export function getLuminance(color: HexColor | RgbColor): number {
  const rgb = typeof color === 'string' ? hexToRgb(color) : color;
  if (!rgb) return 0;
  const linear = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

/** Calculate the WCAG contrast ratio between two colours. */
export function getContrastRatio(color1: HexColor | RgbColor, color2: HexColor | RgbColor): number {
  const luminance1 = getLuminance(color1);
  const luminance2 = getLuminance(color2);
  return (Math.max(luminance1, luminance2) + 0.05) / (Math.min(luminance1, luminance2) + 0.05);
}

export function isLightColor(color: HexColor | RgbColor): boolean {
  return getLuminance(color) > 0.5;
}

/** Choose black or white text according to which has the greater WCAG contrast. */
export function getReadableTextColor(background: HexColor | RgbColor): 'light' | 'dark' {
  return getLuminance(background) > BLACK_LUMINANCE_CUTOFF ? 'dark' : 'light';
}

/**
 * Normalize optional API colours at the UI boundary so malformed persisted
 * values cannot enter CSS generation, even if a caller bypasses API validation.
 */
export function buildFlightVisualTheme(
  airline: Airline | null,
  flight: Pick<FlightRecord, 'boardingPassColor'> | null,
): FlightVisualTheme {
  const validOrNull = (color: unknown): HexColor | null => (isValidHexColor(color) ? color : null);

  return {
    airlinePrimary: validOrNull(airline?.brandColors.primary),
    airlineContrast: validOrNull(airline?.brandColors.contrast),
    flightColor: validOrNull(flight?.boardingPassColor),
  };
}

/** Prefer flight branding, then airline branding, before a mode-safe surface. */
export function getThemeBackground(theme: FlightVisualTheme, isDarkMode: boolean): string {
  const primary = theme.flightColor ?? theme.airlinePrimary;
  return primary ? hexToCss(primary) : isDarkMode ? DARK_SURFACE : LIGHT_SURFACE;
}

/** Flight color is reused for its border; airline contrast remains its fallback. */
export function getThemeBorder(theme: FlightVisualTheme): string {
  const contrast = theme.flightColor ?? theme.airlineContrast;
  return contrast ? hexToCss(contrast) : TRANSPARENT;
}

/** Linearly blend two colours. Values outside the interpolation range are clamped. */
export function lerpColor(color1: HexColor | RgbColor, color2: HexColor | RgbColor, t: number): HexColor {
  const rgb1 = typeof color1 === 'string' ? hexToRgb(color1) : color1;
  const rgb2 = typeof color2 === 'string' ? hexToRgb(color2) : color2;
  if (!rgb1 || !rgb2) return (typeof color1 === 'string' ? color1 : rgbToHex(color1));
  const progress = Math.min(1, Math.max(0, t));
  const lerpChannel = (first: number, second: number) => Math.round(first + (second - first) * progress);

  return rgbToHex({
    r: lerpChannel(rgb1.r, rgb2.r),
    g: lerpChannel(rgb1.g, rgb2.g),
    b: lerpChannel(rgb1.b, rgb2.b),
  });
}


/** Build a multi-layer blended background with smooth transitions between
 *  airline (outer) and flight (inner) colours. Uses overlapping gradients
 *  to create natural colour blending without harsh edges.
 *
 *  In dark mode, bright colours are reduced in opacity to avoid clashing
 *  with white text. In light mode, colours can be more saturated.
 *
 *  The inner layer uses an organic yin-yang inspired pattern: two offset
 *  radial gradients create a soft S-curve colour division without hard
 *  boundaries. All gradients fade smoothly to transparent at their edges
 *  to prevent rendering artifacts at container boundaries. */
export function createBlendedBackground(
  airlinePrimary: HexColor | null,
  airlineContrast: HexColor | null,
  flightPrimary: HexColor | null,
  flightContrast: HexColor | null,
  isDarkMode: boolean,
): string {
  const baseSurface = isDarkMode ? DARK_SURFACE : LIGHT_SURFACE;

  // If no colours defined, return solid surface
  if (!airlinePrimary && !airlineContrast && !flightPrimary && !flightContrast) {
    return baseSurface;
  }

  // Adjust opacity based on theme mode
  // Dark mode: reduce bright colours to avoid clashing with white text
  // Light mode: can use bolder colours
  const outerOpacity = isDarkMode ? 0.18 : 0.28;
  const innerOpacity = isDarkMode ? 0.15 : 0.22;

  const layers: string[] = [];

  // Inner layer: organic yin-yang pattern (flight colours)
  // Uses overlapping radial gradients positioned asymmetrically to create
  // a flowing S-curve colour division without hard edges
  if (flightPrimary && flightContrast) {
    const color1 = alpha(hexToCss(flightPrimary), innerOpacity);
    const color2 = alpha(hexToCss(flightContrast), innerOpacity);
    // Primary colour: offset to upper-left, large soft ellipse
    layers.push(`radial-gradient(ellipse 80% 90% at 35% 40%, ${color1} 0%, transparent 55%)`);
    // Contrast colour: offset to lower-right, large soft ellipse
    layers.push(`radial-gradient(ellipse 80% 90% at 65% 60%, ${color2} 0%, transparent 55%)`);
    // Center blend: subtle mix where colours overlap
    const blendedColor = alpha(lerpColor(flightPrimary, flightContrast, 0.5), innerOpacity * 0.6);
    layers.push(`radial-gradient(ellipse 50% 70% at 50% 50%, ${blendedColor} 0%, transparent 45%)`);
  } else if (flightPrimary) {
    // Only primary: soft rectangular glow
    const color = alpha(hexToCss(flightPrimary), innerOpacity);
    layers.push(`radial-gradient(ellipse 80% 70% at 50% 50%, ${color} 0%, transparent 65%)`);
  } else if (flightContrast) {
    // Only contrast: soft rectangular glow
    const color = alpha(hexToCss(flightContrast), innerOpacity);
    layers.push(`radial-gradient(ellipse 80% 70% at 50% 50%, ${color} 0%, transparent 65%)`);
  }

  // Outer layer: linear gradient (airline colours)
  // Covers the full card and provides the base colour wash
  if (airlinePrimary || airlineContrast) {
    if (airlinePrimary && airlineContrast) {
      const color1 = alpha(hexToCss(airlinePrimary), outerOpacity);
      const color2 = alpha(hexToCss(airlineContrast), outerOpacity);
      layers.push(`linear-gradient(135deg, ${color1} 0%, ${color2} 100%)`);
    } else if (airlinePrimary) {
      const color = alpha(hexToCss(airlinePrimary), outerOpacity);
      layers.push(`linear-gradient(135deg, ${color} 0%, transparent 100%)`);
    } else if (airlineContrast) {
      const color = alpha(hexToCss(airlineContrast), outerOpacity);
      layers.push(`linear-gradient(135deg, transparent 0%, ${color} 100%)`);
    }
  }

  // Base surface (always last)
  layers.push(baseSurface);

  return layers.join(', ');
}
