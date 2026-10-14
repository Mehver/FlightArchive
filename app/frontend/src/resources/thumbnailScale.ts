// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Scales accepted by the backend thumbnail relay, largest first. */
export const THUMBNAIL_SCALES = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625] as const;
export type ThumbnailScale = (typeof THUMBNAIL_SCALES)[number];

export const THUMBNAIL_PIXEL_BUDGET = 4_000_000;
export const THUMBNAIL_DIMENSION_LIMIT = 4096;
export const THUMBNAIL_SOURCE_BYTES_HINT = 2 * 1024 * 1024;
export const DETAIL_PREVIEW_DIMENSION = 512;
export const THUMBNAIL_QUALITY_WIDTH = 1280;
export const THUMBNAIL_QUALITY_HEIGHT = 720;
export interface ThumbnailScaleSource {
  sourceWidth: number;
  sourceHeight: number;
  sourceBytes: number;
  qualityWidth: number;
  qualityHeight: number;
}

/** Largest relay output that remains inside the backend's hard decode budget. */
export function selectStudioThumbnailScale(source: { sourceWidth: number; sourceHeight: number }): ThumbnailScale {
  const { sourceWidth, sourceHeight } = source;
  if (![sourceWidth, sourceHeight].every(Number.isFinite)
    || !Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight)
    || sourceWidth <= 0 || sourceHeight <= 0) throw new Error('invalid-thumbnail-scale-input');
  const budget = Math.min(
    1,
    THUMBNAIL_DIMENSION_LIMIT / sourceWidth,
    THUMBNAIL_DIMENSION_LIMIT / sourceHeight,
    Math.sqrt(THUMBNAIL_PIXEL_BUDGET / (sourceWidth * sourceHeight)),
  );
  return THUMBNAIL_SCALES.find((scale) => scale <= budget) ?? THUMBNAIL_SCALES[THUMBNAIL_SCALES.length - 1];
}

/**
 * Chooses the smallest dyadic derivative that meets the fixed detail-preview
 * quality reference. Consumer canvas size is intentionally absent, so list,
 * grid and detail presentations of one saved slot share the detail URL. Safety
 * remains bounded by complete-source dimensions and the source-byte hint.
 */
export function selectThumbnailScale(source: ThumbnailScaleSource): ThumbnailScale {
  const { sourceWidth, sourceHeight, sourceBytes, qualityWidth, qualityHeight } = source;
  if (![sourceWidth, sourceHeight, sourceBytes, qualityWidth, qualityHeight].every(Number.isFinite)
    || !Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || !Number.isInteger(sourceBytes)
    || sourceWidth <= 0 || sourceHeight <= 0 || sourceBytes <= 0 || qualityWidth <= 0 || qualityHeight <= 0) {
    throw new Error('invalid-thumbnail-scale-input');
  }
  const desired = Math.min(
    1,
    DETAIL_PREVIEW_DIMENSION / Math.max(qualityWidth, qualityHeight),
    THUMBNAIL_QUALITY_WIDTH / qualityWidth,
    THUMBNAIL_QUALITY_HEIGHT / qualityHeight,
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
  return [...permitted].reverse().find((scale) => scale >= desired) ?? largestPermitted;
}
