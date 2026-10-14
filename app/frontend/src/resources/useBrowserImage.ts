// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useMemo, useRef, useState } from 'react';
import { resourceUrl } from '../rfg/api';
import { browserImageRenderer, DEFAULT_RENDER_DIMENSION, type RenderCrop } from './browserImageRenderer';
import { useImageRequestActive } from './ImageRequestScope';

const SVG_PATH = /\.svg$/i;
export type BrowserImageState =
  | { status: 'loading'; src: null; error?: undefined }
  | { status: 'ready'; src: string; original: false; error?: undefined }
  | { status: 'failed'; src: null; error: unknown };

/** SVG remains direct. Raster display is relay-only and never falls back to the
 * private original route. Inactive pending work is aborted while an already
 * ready consumer URL remains owned until its inputs change or it unmounts. */
export function useBrowserImage(resourcePath: string | null, options: { crop?: RenderCrop; qualityCrop?: Pick<RenderCrop, 'width' | 'height'>; maxDimension?: number; enabled?: boolean } = {}): BrowserImageState {
  const cropKey = options.crop ? [options.crop.centerX, options.crop.centerY, options.crop.width, options.crop.height, options.crop.rotationDegrees].join(',') : '';
  const stableCrop = useMemo(() => options.crop ? { centerX: options.crop.centerX, centerY: options.crop.centerY, width: options.crop.width, height: options.crop.height, rotationDegrees: options.crop.rotationDegrees } : undefined, [cropKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const qualityCropKey = options.qualityCrop ? `${options.qualityCrop.width},${options.qualityCrop.height}` : '';
  const stableQualityCrop = useMemo(() => options.qualityCrop ? { width: options.qualityCrop.width, height: options.qualityCrop.height } : undefined, [qualityCropKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const svg = Boolean(resourcePath && SVG_PATH.test(resourcePath));
  const requestScopeActive = useImageRequestActive();
  const enabled = (options.enabled ?? true) && requestScopeActive;
  const [state, setState] = useState<BrowserImageState>(() => svg ? { status: 'ready', src: resourceUrl(resourcePath!), original: false } : { status: 'loading', src: null });
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const rendered = useRef<Awaited<ReturnType<typeof browserImageRenderer.render>> | null>(null);

  useEffect(() => {
    generation.current += 1;
    controller.current?.abort(); controller.current = null;
    if (rendered.current) browserImageRenderer.release(rendered.current);
    rendered.current = null;
    if (!resourcePath) { setState({ status: 'failed', src: null, error: new Error('resource-path-missing') }); return; }
    if (SVG_PATH.test(resourcePath)) { setState({ status: 'ready', src: resourceUrl(resourcePath), original: false }); return; }
    setState({ status: 'loading', src: null });
    return () => {
      generation.current += 1;
      controller.current?.abort(); controller.current = null;
      if (rendered.current) browserImageRenderer.release(rendered.current);
      rendered.current = null;
    };
  }, [resourcePath, stableCrop, stableQualityCrop, options.maxDimension]);

  useEffect(() => {
    if (!resourcePath || SVG_PATH.test(resourcePath) || rendered.current) return;
    if (!enabled) { generation.current += 1; controller.current?.abort(); controller.current = null; return; }
    const requestController = new AbortController();
    const requestGeneration = ++generation.current;
    controller.current = requestController;
    void browserImageRenderer.render({ virtualPath: resourcePath, crop: stableCrop, qualityCrop: stableQualityCrop, maxDimension: options.maxDimension ?? DEFAULT_RENDER_DIMENSION, signal: requestController.signal }).then((result) => {
      if (generation.current !== requestGeneration || requestController.signal.aborted) { browserImageRenderer.release(result); return; }
      controller.current = null; rendered.current = result; setState({ status: 'ready', src: result.url, original: false });
    }, (error: unknown) => {
      if (generation.current !== requestGeneration || error instanceof DOMException && error.name === 'AbortError') return;
      controller.current = null;
      setState({ status: 'failed', src: null, error });
    });
    return () => {
      if (controller.current === requestController) controller.current = null;
      if (!rendered.current) { generation.current += 1; requestController.abort(); }
    };
  }, [resourcePath, stableCrop, stableQualityCrop, options.maxDimension, enabled]);
  return state;
}
