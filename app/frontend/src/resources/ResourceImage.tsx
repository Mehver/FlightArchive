// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import { useBrowserImage } from './useBrowserImage';
import { useNearViewport } from './useNearViewport';

/** Displays a mapped resource as a bounded relay thumbnail. The stable wrapper
 * remains observed while image state changes, so offscreen work is released. */
export function ResourceImage({ resourcePath, size = 56, alt, contain = false }: { resourcePath: string; size?: number; alt: string; contain?: boolean }) {
  const visibility = useNearViewport<HTMLElement>();
  const image = useBrowserImage(resourcePath, { maxDimension: Math.max(1, size * 2), enabled: visibility.enabled });
  const [elementFailed, setElementFailed] = useState(false);
  useEffect(() => setElementFailed(false), [resourcePath, image.src]);
  const unavailable = image.status === 'failed' || elementFailed;
  const failureReason = image.status === 'failed' ? String(image.error) : elementFailed ? 'image-element-load-failed' : undefined;
  return (
    <Box ref={visibility.ref} title={failureReason} role={image.status === 'ready' && !elementFailed ? undefined : 'img'} aria-label={image.status === 'ready' && !elementFailed ? undefined : alt} sx={{ width: size, height: size, display: 'grid', placeItems: 'center', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      {image.status === 'ready' && !elementFailed ? <Box component="img" src={image.src} alt={alt} loading="lazy" onError={() => setElementFailed(true)} sx={{ width: '100%', height: '100%', objectFit: contain ? 'contain' : 'cover', display: 'block' }} /> : null}
      {unavailable ? <BrokenImageOutlinedIcon fontSize="small" aria-hidden /> : null}
    </Box>
  );
}
