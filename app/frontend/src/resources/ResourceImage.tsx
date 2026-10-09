// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useLayoutEffect, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import { useBrowserImage } from './useBrowserImage';
import { useNearViewport } from './useNearViewport';
import { useTranslation } from '../i18n';

/** Displays a mapped resource as a bounded relay thumbnail. The stable wrapper
 * remains observed while image state changes. */
export function ResourceImage({ resourcePath, size = 56, alt, contain = false }: { resourcePath: string; size?: number; alt: string; contain?: boolean }) {
  const { t } = useTranslation();
  const visibility = useNearViewport<HTMLElement>();
  const image = useBrowserImage(resourcePath, { maxDimension: Math.max(1, size * 2), enabled: visibility.enabled });
  const [elementFailed, setElementFailed] = useState(false);
  const [elementLoaded, setElementLoaded] = useState(false);
  useEffect(() => setElementFailed(false), [resourcePath, image.src]);
  useLayoutEffect(() => setElementLoaded(false), [resourcePath, image.src]);
  const unavailable = image.status === 'failed' || elementFailed;
  const loading = visibility.enabled && !unavailable && (image.status === 'loading' || image.status === 'ready' && !elementLoaded);
  const failureReason = image.status === 'failed' ? String(image.error) : elementFailed ? 'image-element-load-failed' : undefined;
  return (
    <Box ref={visibility.ref} title={failureReason} role={image.status === 'ready' && !elementFailed ? undefined : 'img'} aria-label={image.status === 'ready' && !elementFailed ? undefined : alt} sx={{ position: 'relative', width: size, height: size, display: 'grid', placeItems: 'center', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      {image.status === 'ready' && !elementFailed ? <Box component="img" src={image.src} alt={alt} loading="lazy" onLoad={() => setElementLoaded(true)} onError={() => setElementFailed(true)} sx={{ width: '100%', height: '100%', objectFit: contain ? 'contain' : 'cover', display: 'block', opacity: elementLoaded ? 1 : 0 }} /> : null}
      {loading ? <CircularProgress size={Math.min(24, Math.max(14, size / 3))} aria-label={t('loading')} sx={{ position: 'absolute' }} /> : null}
      {unavailable ? <BrokenImageOutlinedIcon fontSize="small" aria-hidden /> : null}
    </Box>
  );
}
