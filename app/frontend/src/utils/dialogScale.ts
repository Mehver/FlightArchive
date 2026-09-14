// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useState } from 'react';

/**
 * Returns a scale factor (0.75–1.25) derived from the current viewport so that
 * fixed-size dialogs adapt proportionally without per-dialog breakpoint logic.
 *
 * The reference design width is 1440 CSS px; the factor is clamped so dialogs
 * never become unusably small on narrow viewports or absurdly large on wide
 * ones. Consumers multiply their design-time width/height by this factor.
 */
export function useDialogScale(): number {
  const [scale, setScale] = useState(() => computeScale());
  useEffect(() => {
    const onResize = () => setScale(computeScale());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return scale;
}

function computeScale(): number {
  if (typeof window === 'undefined') return 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const widthScale = width / 1440;
  const heightScale = height / 900;
  const raw = Math.min(widthScale, heightScale);
  return Math.round(Math.min(1.25, Math.max(0.75, raw)) * 100) / 100;
}

/** Multiply a design-time pixel value by the scale factor. */
export function scaled(value: number, scale: number): number {
  return Math.round(value * scale);
}
