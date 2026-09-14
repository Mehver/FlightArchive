// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import {
  isScanWorkerResponse,
  type DetectionAlgorithm,
  type ScanWorkerResponse,
  type WorkerCrop,
  type WorkerDetectionResult,
} from './scanWorkerProtocol';

const REQUEST_TIMEOUT_MS = 60_000;

type Pending = {
  resolve: (response: ScanWorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RequestToSend =
  | { type: 'detect'; image: ImageBitmap; algorithm: DetectionAlgorithm }
  | { type: 'crop'; image: ImageBitmap; crop: WorkerCrop };

/**
 * Per-dialog worker connection. A timed-out, failed, or disposed connection is
 * terminated rather than reused: OpenCV calls are synchronous and cannot be
 * safely cancelled in-process. This also releases its WASM heap promptly.
 */
export class ScanWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  async detect(image: ImageBitmap, algorithm: DetectionAlgorithm): Promise<WorkerDetectionResult | null> {
    const response = await this.request({ type: 'detect', image, algorithm }, [image]);
    if (!response.ok || response.type !== 'detect') throw new Error('scan-worker-invalid-response');
    return response.result;
  }

  async crop(image: ImageBitmap, crop: WorkerCrop): Promise<{ blob: Blob; width: number; height: number }> {
    const response = await this.request({ type: 'crop', image, crop }, [image]);
    if (!response.ok || response.type !== 'crop') throw new Error('scan-worker-invalid-response');
    return { blob: response.blob, width: response.width, height: response.height };
  }

  dispose(): void {
    this.reset(new Error('scan-worker-disposed'));
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    // Classic worker (Vite bundles `scanWorker.ts` + its imports to IIFE). A
    // module worker cannot call `importScripts('/opencv/opencv.js')`, so the
    // constructor must stay type-less to keep the worker off the main thread
    // while still loading OpenCV's classic script inside it.
    const worker = new Worker(new URL('./scanWorker.ts', import.meta.url));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!isScanWorkerResponse(event.data)) return;
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      clearTimeout(pending.timer);
      if (event.data.ok) pending.resolve(event.data);
      else pending.reject(new Error(`${event.data.code}: ${event.data.message}`));
    };
    worker.onerror = () => this.reset(new Error('scan-worker-failed'));
    worker.onmessageerror = () => this.reset(new Error('scan-worker-message-failed'));
    this.worker = worker;
    return worker;
  }

  private request(
    request: RequestToSend,
    transfer: Transferable[],
  ): Promise<ScanWorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Termination is the only reliable way to interrupt a hung WASM call.
        this.reset(new Error('scan-worker-timeout'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.getWorker().postMessage({ ...request, id }, transfer);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('scan-worker-post-failed'));
      }
    });
  }

  private reset(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
