// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import { SearchHighlight } from './SearchHighlight';

export function isHorizontallyOverflowing(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth > clientWidth;
}

export function MarqueeCopyText({ value, displayText = value, query, copiedLabel, ariaLabel, onCopied }: {
  value: string;
  displayText?: string;
  query?: string;
  copiedLabel: string;
  ariaLabel: string;
  onCopied?: (value: string) => void;
}) {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [distance, setDistance] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const measure = useCallback(() => {
    const viewport = viewportRef.current, text = textRef.current;
    if (!viewport || !text) return;
    const next = text.scrollWidth - viewport.clientWidth;
    setDistance(isHorizontallyOverflowing(text.scrollWidth, viewport.clientWidth) ? Math.max(0, next) : 0);
  }, []);

  useLayoutEffect(measure, [displayText, measure]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !viewportRef.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [measure]);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      onCopied?.(value);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1000);
    } catch {
      // Clipboard availability is best-effort; failed copies remain silent.
    }
  };

  const moving = hovered && distance > 0;
  return <Box
    component="button"
    type="button"
    aria-label={ariaLabel}
    onClick={() => void copy()}
    onMouseEnter={() => { measure(); setHovered(true); }}
    onMouseLeave={() => setHovered(false)}
    sx={{
      appearance: 'none', border: 0, borderRadius: 0.5, background: copied ? 'action.selected' : 'transparent',
      color: 'inherit', cursor: 'copy', display: 'flex', alignItems: 'center', gap: 0.75,
      font: 'inherit', m: 0, maxWidth: '100%', minWidth: 0, p: 0, textAlign: 'left', width: '100%',
      transition: 'background-color 150ms',
    }}
  >
    <Box component="span" ref={viewportRef} sx={{ display: 'block', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', flex: '1 1 auto' }}>
      <Box
        component="span"
        ref={textRef}
        sx={{
          display: 'block', overflow: moving ? 'visible' : 'hidden', textOverflow: moving ? 'clip' : 'ellipsis',
          whiteSpace: 'nowrap', transform: moving ? `translateX(-${distance}px)` : 'translateX(0)',
          transitionProperty: 'transform', transitionTimingFunction: 'linear',
          transitionDuration: moving ? `${Math.max(1, distance / 40)}s` : '180ms',
        }}
      >
        <SearchHighlight text={displayText} query={query} />
      </Box>
    </Box>
    {copied ? <Box component="span" sx={{ color: 'success.main', flex: '0 0 auto', fontWeight: 600 }}>{copiedLabel}</Box> : null}
  </Box>;
}
