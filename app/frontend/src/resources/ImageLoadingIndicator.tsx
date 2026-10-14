// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';

const MIN_INDICATOR_SIZE = 12;
const MAX_INDICATOR_SIZE = 24;
const DEFAULT_INDICATOR_SIZE = 18;
export const IMAGE_LOADING_INDICATOR_DELAY_MS = 150;

export function imageLoadingIndicatorSize(width: number, height: number): number {
  const shorterSide = Math.min(width, height);
  if (!Number.isFinite(shorterSide) || shorterSide <= 0) return DEFAULT_INDICATOR_SIZE;
  return Math.min(MAX_INDICATOR_SIZE, Math.max(MIN_INDICATOR_SIZE, Math.round(shorterSide / 2)));
}

/** A delayed, overlay-only image loader which scales to the shorter host edge. */
export function ImageLoadingIndicator({ loading, label }: { loading: boolean; label: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  const [size, setSize] = useState(DEFAULT_INDICATOR_SIZE);

  useEffect(() => {
    if (!loading) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), IMAGE_LOADING_INDICATOR_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useLayoutEffect(() => {
    if (!loading) return;
    const host = hostRef.current;
    if (!host) return;
    const update = (width: number, height: number) => setSize(imageLoadingIndicatorSize(width, height));
    const rect = host.getBoundingClientRect();
    update(rect.width, rect.height);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [loading]);

  return (
    <Box
      ref={hostRef}
      data-testid="image-loading-indicator-host"
      sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}
    >
      {loading && shown ? <CircularProgress size={size} aria-label={label} /> : null}
    </Box>
  );
}
