// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useMemo, useState } from 'react';
import { resourceUrl } from '../rfg/api';
import { browserImageRenderer, DEFAULT_RENDER_DIMENSION, type RenderCrop } from './browserImageRenderer';

const SVG_PATH = /\.svg$/i;
export type BrowserImageState =
  | { status: 'loading'; src: null; error?: undefined }
  | { status: 'ready'; src: string; original: false; error?: undefined }
  | { status: 'failed'; src: null; error: unknown };

/** SVG remains direct. Raster display is relay-only and never falls back to the
 * private original route. `enabled=false` aborts work and releases its URL. */
export function useBrowserImage(resourcePath: string | null, options: { crop?: RenderCrop; maxDimension?: number; enabled?: boolean } = {}): BrowserImageState {
  const cropKey = options.crop ? [options.crop.centerX, options.crop.centerY, options.crop.width, options.crop.height, options.crop.rotationDegrees].join(',') : '';
  const stableCrop = useMemo(() => options.crop ? { centerX: options.crop.centerX, centerY: options.crop.centerY, width: options.crop.width, height: options.crop.height, rotationDegrees: options.crop.rotationDegrees } : undefined, [cropKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const svg = Boolean(resourcePath && SVG_PATH.test(resourcePath));
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<BrowserImageState>(() => svg ? { status: 'ready', src: resourceUrl(resourcePath!), original: false } : { status: 'loading', src: null });
  useEffect(() => {
    if (!resourcePath) { setState({ status: 'failed', src: null, error: new Error('resource-path-missing') }); return; }
    if (SVG_PATH.test(resourcePath)) { setState({ status: 'ready', src: resourceUrl(resourcePath), original: false }); return; }
    if (!enabled) { setState({ status: 'loading', src: null }); return; }
    const controller = new AbortController(); let active = true; let rendered: Awaited<ReturnType<typeof browserImageRenderer.render>> | null = null;
    setState({ status: 'loading', src: null });
    void browserImageRenderer.render({ virtualPath: resourcePath, crop: stableCrop, maxDimension: options.maxDimension ?? DEFAULT_RENDER_DIMENSION, signal: controller.signal }).then((result) => {
      if (!active) { browserImageRenderer.release(result); return; }
      rendered = result; setState({ status: 'ready', src: result.url, original: false });
    }, (error: unknown) => {
      if (!active || error instanceof DOMException && error.name === 'AbortError') return;
      setState({ status: 'failed', src: null, error });
    });
    return () => { active = false; controller.abort(); if (rendered) browserImageRenderer.release(rendered); };
  }, [resourcePath, stableCrop, options.maxDimension, enabled]);
  return state;
}
