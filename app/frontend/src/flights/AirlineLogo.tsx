// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useMemo, useState } from 'react';
import { Box, useTheme } from '@mui/material';
import { resourceDisplayUrl } from '../rfg/api';

/** A symbol mark is always fitted inside a square, including when its host is round. */
export function AirlineLogo({
  symbolLogoResourcePath,
  code,
  label,
  width,
  height,
}: {
  symbolLogoResourcePath: string | null | undefined;
  code: string;
  label: string;
  width: number;
  height: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [symbolLogoResourcePath]);
  const hasSymbol = Boolean(symbolLogoResourcePath) && !failed;
  const side = Math.min(width, height);

  return (
    <Box
      role="img"
      aria-label={label}
      sx={{ width, height, flex: '0 0 auto', display: 'grid', placeItems: 'center', overflow: 'hidden' }}
    >
      {hasSymbol ? (
        <Box
          component="img"
          src={resourceDisplayUrl(symbolLogoResourcePath!)}
          alt=""
          aria-hidden
          loading="lazy"
          onError={() => setFailed(true)}
          sx={{ width: side, height: side, objectFit: 'contain', display: 'block' }}
        />
      ) : (
        <Box
          aria-hidden
          sx={{ width: side, height: side, display: 'grid', placeItems: 'center', bgcolor: 'primary.main', color: 'primary.contrastText', fontSize: side <= 36 ? '0.68rem' : '0.78rem', fontWeight: 800, letterSpacing: 0.5 }}
        >
          {code || '—'}
        </Box>
      )}
    </Box>
  );
}

/** Theme-selectable horizontal mark. It intentionally has no artwork fallback. */
export function AirlineHorizontalLogo({
  horizontalLogoResourcePath,
  horizontalDarkLogoResourcePath,
  label,
  maxWidth = 220,
  maxHeight = 42,
}: {
  horizontalLogoResourcePath: string | null | undefined;
  horizontalDarkLogoResourcePath: string | null | undefined;
  label: string;
  maxWidth?: number;
  maxHeight?: number;
}) {
  const theme = useTheme();
  const sources = useMemo(() => {
    const paths = theme.palette.mode === 'dark'
      ? [horizontalDarkLogoResourcePath, horizontalLogoResourcePath]
      : [horizontalLogoResourcePath, horizontalDarkLogoResourcePath];
    return paths.filter((path, index): path is string => Boolean(path) && paths.indexOf(path) === index).map(resourceDisplayUrl);
  }, [horizontalDarkLogoResourcePath, horizontalLogoResourcePath, theme.palette.mode]);
  const [sourceIndex, setSourceIndex] = useState(0);
  useEffect(() => setSourceIndex(0), [sources]);
  const src = sources[sourceIndex];
  if (!src) return null;

  return (
    <Box
      component="img"
      src={src}
      alt={label}
      loading="eager"
      onError={() => setSourceIndex((index) => index + 1)}
      sx={{
        display: 'block',
        width: '100%',
        height: '100%',
        maxWidth,
        maxHeight,
        objectFit: 'contain',
      }}
    />
  );
}
