// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

export type DetectionAlgorithm = 'adaptive' | 'canny' | 'sobel' | 'laplacian';
export const DETECTION_ALGORITHMS: DetectionAlgorithm[] = ['adaptive', 'canny', 'sobel', 'laplacian'];

export interface WorkerCrop {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationDegrees: number;
}

export interface WorkerDetectionResult {
  center: { x: number; y: number };
  size: { width: number; height: number };
  rotation: number;
}

export type ScanWorkerRequest =
  | { id: number; type: 'detect'; image: ImageBitmap; algorithm: DetectionAlgorithm }
  | { id: number; type: 'crop'; image: ImageBitmap; crop: WorkerCrop };

/** Failure codes carried by {@link ScanWorkerResponse}. */
export type ScanWorkerErrorCode = 'opencv-init-failed' | 'processing-failed';

/**
 * Typed error for OpenCV script/runtime initialisation failures inside the
 * worker. Throwing this (rather than a bare `Error` whose message happens to
 * start with `opencv-`) lets the worker classify failures reliably via
 * {@link classifyWorkerError} instead of fragile message-prefix sniffing.
 */
export class OpenCvInitError extends Error {
  readonly code: 'opencv-init-failed' = 'opencv-init-failed';
  constructor(message: string) {
    super(message);
    this.name = 'OpenCvInitError';
  }
}

/** Map a thrown worker error to a protocol error code without string sniffing. */
export function classifyWorkerError(error: unknown): ScanWorkerErrorCode {
  return error instanceof OpenCvInitError ? 'opencv-init-failed' : 'processing-failed';
}

export type ScanWorkerResponse =
  | { id: number; ok: true; type: 'detect'; result: WorkerDetectionResult | null }
  | { id: number; ok: true; type: 'crop'; blob: Blob; width: number; height: number }
  | { id: number; ok: false; code: ScanWorkerErrorCode; message: string };

/** Narrow unknown worker messages before they can settle a UI request. */
export function isScanWorkerResponse(value: unknown): value is ScanWorkerResponse {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ScanWorkerResponse> & Record<string, unknown>;
  if (!isFiniteNumber(message.id) || typeof message.ok !== 'boolean') return false;
  if (!message.ok) {
    return (message.code === 'opencv-init-failed' || message.code === 'processing-failed') && typeof message.message === 'string';
  }
  if (message.type === 'detect') return message.result === null || isDetectionResult(message.result);
  return message.type === 'crop'
    && message.blob instanceof Blob
    && isFiniteNumber(message.width)
    && message.width > 0
    && isFiniteNumber(message.height)
    && message.height > 0;
}

function isDetectionResult(value: unknown): value is WorkerDetectionResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<WorkerDetectionResult>;
  return isPoint(result.center)
    && isSize(result.size)
    && isFiniteNumber(result.rotation);
}

function isPoint(value: unknown): value is WorkerDetectionResult['center'] {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<WorkerDetectionResult['center']>;
  return isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function isSize(value: unknown): value is WorkerDetectionResult['size'] {
  if (!value || typeof value !== 'object') return false;
  const size = value as Partial<WorkerDetectionResult['size']>;
  return isFiniteNumber(size.width) && size.width > 0 && isFiniteNumber(size.height) && size.height > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
