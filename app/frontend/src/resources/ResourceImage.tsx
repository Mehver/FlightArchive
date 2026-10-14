// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useLayoutEffect, useState } from 'react';
import { Box } from '@mui/material';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import { useBrowserImage } from './useBrowserImage';
import { useNearViewport } from './useNearViewport';
import { useTranslation } from '../i18n';
import { ImageLoadingIndicator } from './ImageLoadingIndicator';
import type { RenderCrop } from './browserImageRenderer';

/** Displays a mapped resource as a bounded relay thumbnail. The stable wrapper
 * remains observed while image state changes. */
export function ResourceImage({ resourcePath, size = 56, alt, contain = false, qualityCrop }: { resourcePath: string; size?: number; alt: string; contain?: boolean; qualityCrop?: Pick<RenderCrop, 'width' | 'height'> }) {
  const { t } = useTranslation();
  const visibility = useNearViewport<HTMLElement>();
  const image = useBrowserImage(resourcePath, { qualityCrop, maxDimension: Math.max(1, size * 2), enabled: visibility.enabled });
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
      <ImageLoadingIndicator loading={loading} label={t('loading')} />
      {unavailable ? <BrokenImageOutlinedIcon fontSize="small" aria-hidden /> : null}
    </Box>
  );
}
