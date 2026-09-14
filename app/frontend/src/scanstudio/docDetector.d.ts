// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Type declarations for `docDetector.js`, the classic-script document edge
 * detector. The script itself installs `globalThis.DocDetect`; the module
 * wrapper `docDetect.ts` loads it and re-exports these typed boundaries for
 * the dedicated scan worker.
 */

/** Detection method keys accepted by {@link DocDetect.detectWith}. */
export type DocDetectMethod = 'adaptive' | 'canny' | 'sobel' | 'laplacian';

export interface DocDetectPoint {
  x: number;
  y: number;
}

export interface DocDetectResult {
  center: DocDetectPoint;
  size: { width: number; height: number };
  rotation: number;
  bgStats: { mean: number; std: number };
}

export interface DocDetectAPI {
  /** Ensure the OpenCV runtime (global `cv`) is ready. */
  load(): Promise<void>;

  /** Run the "adaptive" algorithm (default). */
  detect(img: CanvasImageSource): Promise<DocDetectResult | null>;

  /** Run a named detection algorithm. */
  detectWith(img: CanvasImageSource, method: DocDetectMethod): Promise<DocDetectResult | null>;

  /**
   * Convert a browser image source to a Mat. OffscreenCanvas is read through
   * ImageData so this remains safe in DedicatedWorkerGlobalScope.
   */
  matFromImageSource(img: CanvasImageSource | OffscreenCanvas): unknown;

  /** Available method names. */
  METHODS: DocDetectMethod[];
}
