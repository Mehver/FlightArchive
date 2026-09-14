// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/// <reference lib="webworker" />

import { DocDetect } from './docDetect';
import {
  OpenCvInitError,
  classifyWorkerError,
  type ScanWorkerRequest,
  type ScanWorkerResponse,
} from './scanWorkerProtocol';

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let cvLoad: Promise<void> | null = null;

interface OpenCvRuntime {
  Mat?: unknown;
  onRuntimeInitialized?: () => void;
  onAbort?: (reason?: unknown) => void;
}

/** Upper bound for OpenCV initialisation inside the worker. */
const OPENCV_INIT_TIMEOUT_MS = 30_000;

function loadOpenCvInWorker(): Promise<void> {
  if (cvLoad) return cvLoad;
  cvLoad = new Promise<void>((resolve, reject) => {
    // OpenCV initialises asynchronously for the pinned single-file build: the
    // WASM payload is embedded as a data URI, `run()` returns early while the
    // instantiation promise is pending, and `cv.Mat` only appears once
    // `onRuntimeInitialized` fires. Wait for that signal (or an abort), and
    // bound the wait so a silently-stuck runtime surfaces as an init failure
    // instead of hanging the request.
    let settled = false;
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cvLoad = null;
      reject(new OpenCvInitError(code));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => fail('opencv-init-timeout'), OPENCV_INIT_TIMEOUT_MS);

    let runtime: OpenCvRuntime | undefined;
    try {
      // Deliberately a classic import: the 11 MB SINGLE_FILE payload evaluates
      // only in this dedicated worker, never in the renderer.
      importScripts('/opencv/opencv.js');
      runtime = (globalThis as { cv?: OpenCvRuntime }).cv;
    } catch (error) {
      // `importScripts` failures (network error, illegal module-worker call,
      // etc.) land here; classify them as init failures, not processing ones.
      fail(error instanceof Error ? `opencv-script-unavailable: ${error.message}` : 'opencv-script-unavailable');
      return;
    }

    if (!runtime) {
      fail('opencv-global-missing');
      return;
    }
    if (typeof runtime.Mat === 'function') {
      // Already initialised (synchronous timing model).
      succeed();
      return;
    }
    runtime.onRuntimeInitialized = succeed;
    runtime.onAbort = (reason?: unknown) => fail(`opencv-runtime-abort${typeof reason === 'string' ? `: ${reason}` : ''}`);
  });
  return cvLoad.catch((error: unknown) => {
    cvLoad = null;
    throw error;
  });
}

function canvasFor(image: ImageBitmap): OffscreenCanvas {
  const Canvas = typeof OffscreenCanvas === 'undefined' ? undefined : OffscreenCanvas;
  if (!Canvas) throw new Error('offscreen-canvas-unavailable');
  const canvas = new Canvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('offscreen-canvas-unavailable');
  context.drawImage(image, 0, 0);
  return canvas;
}

async function crop(image: ImageBitmap, crop: { centerX: number; centerY: number; width: number; height: number; rotationDegrees: number }) {
  if (!Number.isFinite(crop.width) || !Number.isFinite(crop.height) || crop.width <= 0 || crop.height <= 0) throw new Error('invalid-crop-rectangle');
  const Canvas = typeof OffscreenCanvas === 'undefined' ? undefined : OffscreenCanvas;
  if (!Canvas) throw new Error('offscreen-canvas-unavailable');
  const width = Math.max(1, Math.round(crop.width));
  const height = Math.max(1, Math.round(crop.height));
  const output = new Canvas(width, height);
  const outputContext = output.getContext('2d');
  if (!outputContext) throw new Error('offscreen-canvas-unavailable');

  // rectToQuad defines positive angles clockwise in canvas/source coordinates.
  // Rotate source-to-output by the inverse angle so that rectangle's top edge
  // is horizontal and its TL/TR/BR/BL pixel orientation is retained.
  outputContext.translate(width / 2, height / 2);
  outputContext.rotate((-crop.rotationDegrees * Math.PI) / 180);
  outputContext.scale(width / crop.width, height / crop.height);
  outputContext.translate(-crop.centerX, -crop.centerY);
  outputContext.drawImage(image, 0, 0);
  return { blob: await output.convertToBlob({ type: 'image/png' }), width, height };
}

scope.onmessage = async (event: MessageEvent<ScanWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'detect') {
      await loadOpenCvInWorker();
      const canvas = canvasFor(request.image);
      const detected = await DocDetect.detectWith(canvas, request.algorithm);
      const result = detected
        ? {
            center: detected.center,
            size: detected.size,
            rotation: detected.rotation,
          }
        : null;
      scope.postMessage({ id: request.id, ok: true, type: 'detect', result } satisfies ScanWorkerResponse);
    } else {
      const result = await crop(request.image, request.crop);
      scope.postMessage({ id: request.id, ok: true, type: 'crop', ...result } satisfies ScanWorkerResponse);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown worker error';
    const code = classifyWorkerError(error);
    scope.postMessage({ id: request.id, ok: false, code, message } satisfies ScanWorkerResponse);
  } finally {
    request.image.close();
  }
};
