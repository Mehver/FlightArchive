// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { describe, expect, it, vi } from 'vitest';
import { BrowserImageRenderer, imageHeaderDimensions, loadBoundedSource, MAX_SOURCE_BYTES, validateRenderBounds } from './browserImageRenderer';

const PNG_HEADER = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 3, 32, 0, 0, 2, 88]);
function response(body: Uint8Array | null, headers: Record<string, string> = {}, status = 200) { return new Response(body ? new Blob([Uint8Array.from(body)]) : null, { status, headers }); }
function relayHeaders(sourceWidth: number, sourceHeight: number, sourceBytes: number, scale: number, etag = '"source"') {
  return {
    'Content-Type': 'image/webp', 'X-Source-Width': String(sourceWidth), 'X-Source-Height': String(sourceHeight),
    'X-Source-Bytes': String(sourceBytes), 'X-Source-ETag': etag, 'X-Thumbnail-Width': String(Math.max(1, Math.floor(sourceWidth * scale))),
    'X-Thumbnail-Height': String(Math.max(1, Math.floor(sourceHeight * scale))), 'X-Thumbnail-Scale': String(scale),
  };
}
function scaleFromUrl(url: RequestInfo | URL) { return Number(new URL(String(url), 'http://test').searchParams.get('scale')); }
function renderer(fetcher: typeof fetch, sourceWidth = 800, sourceHeight = 600) {
  const context = { drawImage: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn() };
  const revokeObjectURL = vi.fn();
  const instance = new BrowserImageRenderer({
    fetcher, decode: vi.fn(async (blob: Blob) => { const scale = Number(await blob.text()); return { source: {} as CanvasImageSource, width: Math.max(1, Math.floor(sourceWidth * scale)), height: Math.max(1, Math.floor(sourceHeight * scale)), close: vi.fn() }; }),
    makeCanvas: vi.fn((width: number, height: number) => ({ width, height, context, toBlob: async () => new Blob(['rendered'], { type: 'image/webp' }) })),
    createObjectURL: vi.fn(() => `blob:${Math.random()}`), revokeObjectURL, now: () => 1000,
  });
  return { instance, context, revokeObjectURL };
}
function relayFetcher(width = 800, height = 600, bytes = 100_000) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { const scale = scaleFromUrl(url); return response(init?.method === 'HEAD' ? null : new TextEncoder().encode(String(scale)), relayHeaders(width, height, bytes, scale)); }) as unknown as typeof fetch;
}

describe('browser image renderer relay cutover', () => {
  it('validates canonical crop bounds', () => {
    expect(validateRenderBounds({ centerX: 400, centerY: 300, width: 800, height: 600, rotationDegrees: 0 }, 800, 600)).toBe(true);
    expect(validateRenderBounds({ centerX: 0, centerY: 0, width: 2, height: 2, rotationDegrees: 0 }, 800, 600)).toBe(false);
  });

  it('keeps lightweight header parsing only for explicit studio originals', () => {
    expect(imageHeaderDimensions(PNG_HEADER)).toEqual({ width: 800, height: 600 });
  });

  it('preflights full studio sources without changing their /res contract', async () => {
    const oversized = vi.fn(async () => response(null, { 'Content-Length': String(MAX_SOURCE_BYTES + 1) }));
    await expect(loadBoundedSource('/res/oversized.png', undefined, oversized as typeof fetch)).rejects.toThrow('source-too-large');
    expect(oversized).toHaveBeenCalledOnce();
  });

  it('uses relay HEAD metadata and relay GET only, never /res, while preserving original crop coordinates', async () => {
    const fetcher = relayFetcher(14_000, 10_000, 500_000);
    const { instance, context } = renderer(fetcher, 14_000, 10_000);
    const crop = { centerX: 7260.99, centerY: 4927.5, width: 9540.97, height: 3897.07, rotationDegrees: -8 };
    const result = await instance.render({ virtualPath: 'nested/large scan.jpg', crop, maxDimension: 1024 });
    expect(result).toMatchObject({ width: 1024, height: 418 });
    const urls = vi.mocked(fetcher).mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(['/api/thumbnails/nested/large%20scan.jpg?scale=0.015625', '/api/thumbnails/nested/large%20scan.jpg?scale=0.125']);
    expect(urls.every((url) => !url.startsWith('/res/'))).toBe(true);
    expect(context.translate).toHaveBeenNthCalledWith(2, -crop.centerX, -crop.centerY);
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 14_000, 10_000);
  });

  it('validates every positive integer header and thumbnail geometry', async () => {
    const missing = vi.fn(async () => response(null, { ...relayHeaders(800, 600, 1000, 0.015625), 'X-Source-Width': '800.5' }));
    await expect(renderer(missing as typeof fetch).instance.render({ virtualPath: 'bad.png' })).rejects.toThrow('invalid-thumbnail-metadata');
    const inconsistent = vi.fn(async () => response(null, { ...relayHeaders(800, 600, 1000, 0.015625), 'X-Thumbnail-Width': '99' }));
    await expect(renderer(inconsistent as typeof fetch).instance.render({ virtualPath: 'bad.png' })).rejects.toThrow('invalid-thumbnail-metadata');
  });

  it('rejects GET metadata that changed since HEAD', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { const scale = scaleFromUrl(url); return response(init?.method === 'HEAD' ? null : new TextEncoder().encode(String(scale)), relayHeaders(800, 600, init?.method === 'HEAD' ? 1000 : 1001, scale)); });
    await expect(renderer(fetcher as typeof fetch).instance.render({ virtualPath: 'changed.png' })).rejects.toThrow('thumbnail-source-changed');
  });

  it('reuses cached final encoded bytes but issues consumer-owned URLs', async () => {
    const fetcher = relayFetcher(); const { instance, revokeObjectURL } = renderer(fetcher);
    const first = await instance.render({ virtualPath: 'same.png' }); const second = await instance.render({ virtualPath: 'same.png' });
    expect(first.url).not.toBe(second.url);
    expect(vi.mocked(fetcher).mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
    instance.release(first); expect(revokeObjectURL).toHaveBeenCalledWith(first.url); instance.dispose(); expect(revokeObjectURL).toHaveBeenCalledWith(second.url);
  });

  it('aborts relay waiting and does not publish a late URL', async () => {
    let started!: () => void; const getStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const scale = scaleFromUrl(url); if (init?.method === 'HEAD') return response(null, relayHeaders(800, 600, 1000, scale));
      started(); await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      return response(new TextEncoder().encode(String(scale)), relayHeaders(800, 600, 1000, scale));
    });
    const instance = renderer(fetcher as typeof fetch).instance; const controller = new AbortController();
    const pending = instance.render({ virtualPath: 'cancel.png', signal: controller.signal }); await getStarted; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects an out-of-bounds crop after metadata without issuing GET', async () => {
    const fetcher = relayFetcher();
    await expect(renderer(fetcher).instance.render({ virtualPath: 'crop.png', crop: { centerX: 0, centerY: 0, width: 20, height: 20, rotationDegrees: 0 } })).rejects.toThrow('invalid-crop-rectangle');
    expect(vi.mocked(fetcher).mock.calls).toHaveLength(1);
  });

  it('rejects a decoded relay body whose dimensions disagree with headers', async () => {
    const fetcher = relayFetcher(900, 600);
    await expect(renderer(fetcher, 800, 600).instance.render({ virtualPath: 'mismatch.png' })).rejects.toThrow('thumbnail-dimensions-mismatch');
  });

  it('draws a whole relay thumbnail to the bounded output canvas', async () => {
    const fetcher = relayFetcher(); const { instance, context } = renderer(fetcher);
    await expect(instance.render({ virtualPath: 'whole.png', maxDimension: 200 })).resolves.toMatchObject({ width: 200, height: 150 });
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 200, 150);
  });

  it('rejects invalid requested display dimensions before any request', async () => {
    const fetcher = relayFetcher();
    await expect(renderer(fetcher).instance.render({ virtualPath: 'bad.png', maxDimension: 0 })).rejects.toThrow('invalid-max-dimension');
    expect(vi.mocked(fetcher).mock.calls).toHaveLength(0);
  });

  it('does not retry /res after a relay GET status failure', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { const scale = scaleFromUrl(url); return init?.method === 'HEAD' ? response(null, relayHeaders(800, 600, 1000, scale)) : response(null, {}, 503); });
    await expect(renderer(fetcher as typeof fetch).instance.render({ virtualPath: 'failed.png' })).rejects.toThrow('resource-fetch-failed:503');
    expect(fetcher.mock.calls.every(([url]) => !String(url).startsWith('/res/'))).toBe(true);
  });

  it('classifies relay transport failures and never retries an original', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('disconnected'); });
    await expect(renderer(fetcher as typeof fetch).instance.render({ virtualPath: 'network.png' })).rejects.toMatchObject({ name: 'ResourceFetchError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
