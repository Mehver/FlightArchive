// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import { resourceDisplayUrl } from '../rfg/api';

/** Displays a mapped resource as a small image. Raster resources are served
 *  from the cached thumbnail route `/images/{virtual_path}`; when that fails
 *  (e.g. unsupported or too large) the broken-image placeholder is shown
 *  instead of falling back to the potentially huge original. Only SVG
 *  virtual paths use the original `/res/{virtual_path}` route directly. */
export function ResourceImage({ resourcePath, size = 56, alt, contain = false }: { resourcePath: string; size?: number; alt: string; contain?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [resourcePath]);
  return failed ? <Box sx={{ width: size, height: size, display: 'grid', placeItems: 'center', border: 1, borderColor: 'divider' }}><BrokenImageOutlinedIcon fontSize="small" /></Box> : (
    <Box component="img" src={resourceDisplayUrl(resourcePath)} alt={alt} loading="lazy" onError={() => setFailed(true)} sx={{ width: size, height: size, objectFit: contain ? 'contain' : 'cover', borderRadius: 1, border: 1, borderColor: 'divider', display: 'block' }} />
  );
}
