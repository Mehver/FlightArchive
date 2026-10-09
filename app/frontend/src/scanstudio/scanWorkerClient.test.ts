// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanWorkerClient } from './scanWorkerClient';

class MockWorker {
  static instances: MockWorker[] = [];
  static nextPostError: unknown;

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly messages: Array<{ message: Record<string, unknown>; transfer: Transferable[] }> = [];
  readonly terminate = vi.fn();

  constructor(_url: URL) {
    MockWorker.instances.push(this);
  }

  postMessage(message: Record<string, unknown>, transfer: Transferable[]): void {
    if (MockWorker.nextPostError !== undefined) {
      const error = MockWorker.nextPostError;
      MockWorker.nextPostError = undefined;
      throw error;
    }
    this.messages.push({ message, transfer });
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

const image = {} as ImageBitmap;
const crop = { centerX: 10, centerY: 20, width: 30, height: 40, rotationDegrees: 5 };

describe('ScanWorkerClient', () => {
  beforeEach(() => {
    MockWorker.instances = [];
    MockWorker.nextPostError = undefined;
    vi.stubGlobal('Worker', MockWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('correlates responses by request id and ignores unknown ids', async () => {
    const client = new ScanWorkerClient();
    const detection = client.detect(image, 'canny');
    const cropped = client.crop(image, crop);
    const worker = MockWorker.instances[0];

    expect(worker.messages.map(({ message }) => message.id)).toEqual([1, 2]);
    expect(worker.messages[0].transfer).toEqual([image]);
    worker.emit({ id: 999, ok: true, type: 'detect', result: null });
    worker.emit({ id: 2, ok: true, type: 'crop', blob: new Blob(['crop']), width: 30, height: 40 });
    await expect(cropped).resolves.toMatchObject({ width: 30, height: 40 });

    const result = { center: { x: 1, y: 2 }, size: { width: 3, height: 4 }, rotation: 5 };
    worker.emit({ id: 1, ok: true, type: 'detect', result });
    await expect(detection).resolves.toEqual(result);
  });

  it('passes canonical source bounds to bounded thumbnail crops', async () => {
    const client = new ScanWorkerClient();
    const pending = client.crop(image, crop, { width: 14_001, height: 10_001 });
    expect(MockWorker.instances[0].messages[0].message).toMatchObject({ sourceBounds: { width: 14_001, height: 10_001 } });
    const rejection = expect(pending).rejects.toThrow('scan-worker-disposed');
    client.dispose();
    await rejection;
  });

  it('terminates the worker and rejects every pending request on timeout', async () => {
    vi.useFakeTimers();
    const client = new ScanWorkerClient();
    const detection = client.detect(image, 'adaptive');
    const cropped = client.crop(image, crop);
    const worker = MockWorker.instances[0];
    const detectionRejection = expect(detection).rejects.toThrow('scan-worker-timeout');
    const cropRejection = expect(cropped).rejects.toThrow('scan-worker-timeout');

    await vi.advanceTimersByTimeAsync(60_000);

    await detectionRejection;
    await cropRejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('dispose terminates the worker, clears timers, and rejects all pending requests', async () => {
    vi.useFakeTimers();
    const client = new ScanWorkerClient();
    const detection = client.detect(image, 'sobel');
    const cropped = client.crop(image, crop);
    const worker = MockWorker.instances[0];
    const detectionRejection = expect(detection).rejects.toThrow('scan-worker-disposed');
    const cropRejection = expect(cropped).rejects.toThrow('scan-worker-disposed');

    client.dispose();

    await detectionRejection;
    await cropRejection;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('cleans up a request when postMessage throws', async () => {
    vi.useFakeTimers();
    const client = new ScanWorkerClient();
    const postError = new Error('clone failed');
    MockWorker.nextPostError = postError;

    await expect(client.detect(image, 'laplacian')).rejects.toBe(postError);
    const worker = MockWorker.instances[0];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(worker.terminate).not.toHaveBeenCalled();

    const next = client.detect(image, 'laplacian');
    expect(worker.messages[0].message.id).toBe(2);
    worker.emit({ id: 2, ok: true, type: 'detect', result: null });
    await expect(next).resolves.toBeNull();
  });
});
