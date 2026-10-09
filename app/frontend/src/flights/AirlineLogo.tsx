// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Box, CircularProgress, useTheme } from '@mui/material';
import { useBrowserImage } from '../resources/useBrowserImage';
import { useNearViewport } from '../resources/useNearViewport';
import { useTranslation } from '../i18n';

function LogoImage({ resourcePath, alt, eager = false, enabled = true, onFailure, sx }: { resourcePath: string; alt: string; eager?: boolean; enabled?: boolean; onFailure(): void; sx: object }) {
  const { t } = useTranslation();
  const image = useBrowserImage(resourcePath, { maxDimension: 512, enabled });
  const [elementLoaded, setElementLoaded] = useState(false);
  useLayoutEffect(() => setElementLoaded(false), [resourcePath, image.src]);
  useEffect(() => { if (image.status === 'failed') onFailure(); }, [image.status, onFailure]);
  return <>
    {image.status === 'ready' ? <Box component="img" src={image.src} alt={alt} aria-hidden={alt ? undefined : true} loading={eager ? 'eager' : 'lazy'} onLoad={() => setElementLoaded(true)} onError={onFailure} sx={{ ...sx, opacity: elementLoaded ? 1 : 0 }} /> : null}
    {enabled && (image.status === 'loading' || image.status === 'ready' && !elementLoaded) ? <Box data-testid="airline-logo-loading" sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}><CircularProgress size={18} aria-label={t('loading')} /></Box> : null}
  </>;
}

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
  const visibility = useNearViewport<HTMLElement>();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [symbolLogoResourcePath]);
  const hasSymbol = Boolean(symbolLogoResourcePath) && !failed;
  const side = Math.min(width, height);

  return (
    <Box
      ref={visibility.ref}
      role="img"
      aria-label={label}
      sx={{ position: 'relative', width, height, flex: '0 0 auto', display: 'grid', placeItems: 'center', overflow: 'hidden' }}
    >
      {hasSymbol ? (
        <LogoImage
          resourcePath={symbolLogoResourcePath!}
          alt=""
          enabled={visibility.enabled}
          onFailure={() => setFailed(true)}
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
  const visibility = useNearViewport<HTMLElement>();
  const sources = useMemo(() => {
    const paths = theme.palette.mode === 'dark'
      ? [horizontalDarkLogoResourcePath, horizontalLogoResourcePath]
      : [horizontalLogoResourcePath, horizontalDarkLogoResourcePath];
    return paths.filter((path, index): path is string => Boolean(path) && paths.indexOf(path) === index);
  }, [horizontalDarkLogoResourcePath, horizontalLogoResourcePath, theme.palette.mode]);
  const [sourceIndex, setSourceIndex] = useState(0);
  useEffect(() => setSourceIndex(0), [sources]);
  const resourcePath = sources[sourceIndex];

  return (
    <Box
      ref={visibility.ref}
      aria-hidden={resourcePath ? undefined : true}
      sx={{
        width: maxWidth,
        height: maxHeight,
        maxWidth: '100%',
        maxHeight: '100%',
        position: 'relative',
        display: 'grid',
        placeItems: 'center',
        visibility: resourcePath ? 'visible' : 'hidden',
      }}
    >
      {resourcePath ? (
        <LogoImage
          key={resourcePath}
          resourcePath={resourcePath}
          alt={label}
          eager
          enabled={visibility.enabled}
          onFailure={() => setSourceIndex((index) => index + 1)}
          sx={{
            display: 'block',
            width: '100%',
            height: '100%',
            maxWidth,
            maxHeight,
            objectFit: 'contain',
          }}
        />
      ) : null}
    </Box>
  );
}
