// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Scales accepted by the backend thumbnail relay, largest first. */
export const THUMBNAIL_SCALES = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625] as const;
export type ThumbnailScale = (typeof THUMBNAIL_SCALES)[number];

export const THUMBNAIL_PIXEL_BUDGET = 4_000_000;
export const THUMBNAIL_DIMENSION_LIMIT = 4096;
export const THUMBNAIL_SOURCE_BYTES_HINT = 2 * 1024 * 1024;
export const THUMBNAIL_QUALITY_WIDTH = 1280;
export const THUMBNAIL_QUALITY_HEIGHT = 720;

export interface ThumbnailScaleRequest {
  sourceWidth: number;
  sourceHeight: number;
  sourceBytes: number;
  crop?: { width: number; height: number };
  maxDimension: number;
}

/**
 * Chooses the smallest supported dyadic scale that reaches the requested crop
 * display quality (within the 1280x720 quality cap). Safety limits are separate
 * upper bounds derived from the complete source: 4 MP, 4096 px, and the
 * conservative compressed-byte hint. If the desired quality is not reachable
 * within those bounds, the largest permitted scale wins.
 */
export function selectThumbnailScale(request: ThumbnailScaleRequest): ThumbnailScale {
  const { sourceWidth, sourceHeight, sourceBytes, crop, maxDimension } = request;
  if (![sourceWidth, sourceHeight, sourceBytes, maxDimension].every(Number.isFinite)
    || !Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || !Number.isInteger(sourceBytes)
    || sourceWidth <= 0 || sourceHeight <= 0 || sourceBytes <= 0 || maxDimension <= 0) {
    throw new Error('invalid-thumbnail-scale-input');
  }
  const displayWidth = crop?.width ?? sourceWidth;
  const displayHeight = crop?.height ?? sourceHeight;
  if (![displayWidth, displayHeight].every(Number.isFinite) || displayWidth <= 0 || displayHeight <= 0) {
    throw new Error('invalid-thumbnail-scale-input');
  }

  const desired = Math.min(
    1,
    maxDimension / Math.max(displayWidth, displayHeight),
    THUMBNAIL_QUALITY_WIDTH / displayWidth,
    THUMBNAIL_QUALITY_HEIGHT / displayHeight,
  );
  const budget = Math.min(
    1,
    THUMBNAIL_DIMENSION_LIMIT / sourceWidth,
    THUMBNAIL_DIMENSION_LIMIT / sourceHeight,
    Math.sqrt(THUMBNAIL_PIXEL_BUDGET / (sourceWidth * sourceHeight)),
    Math.sqrt(THUMBNAIL_SOURCE_BYTES_HINT / sourceBytes),
  );
  const permitted = THUMBNAIL_SCALES.filter((scale) => scale <= budget);
  const largestPermitted = permitted[0] ?? THUMBNAIL_SCALES[THUMBNAIL_SCALES.length - 1];
  const qualityScale = [...permitted].reverse().find((scale) => scale >= desired);
  return qualityScale ?? largestPermitted;
}
