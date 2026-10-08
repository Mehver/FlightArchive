// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { thumbnailUrl } from '../rfg/api';
import { selectThumbnailScale, type ThumbnailScale } from './thumbnailScale';

export const MAX_SOURCE_BYTES = 24 * 1024 * 1024;
export const MAX_DECODED_PIXELS = 40_000_000;
export const MAX_DECODED_DIMENSION = 16_384;
export const DEFAULT_RENDER_DIMENSION = 512;
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 48;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 60_000;
const METADATA_SCALE: ThumbnailScale = 0.015625;

export interface RenderCrop {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationDegrees: number;
  /** Old documents may contain corners. Rendering intentionally ignores them. */
  corners?: unknown;
}
export interface RenderRequest { virtualPath: string; crop?: RenderCrop; maxDimension?: number; signal?: AbortSignal }
export interface RenderedImage { url: string; width: number; height: number; type: string }
interface DecodedImage { source: CanvasImageSource; width: number; height: number; close(): void }
interface RenderCanvas {
  width: number;
  height: number;
  context: Pick<CanvasRenderingContext2D, 'drawImage' | 'translate' | 'rotate' | 'scale'>;
  toBlob(): Promise<Blob>;
}
interface RendererDependencies {
  fetcher: typeof fetch;
  decode(blob: Blob): Promise<DecodedImage>;
  makeCanvas(width: number, height: number): RenderCanvas;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  now(): number;
}
interface CacheEntry { blob: Blob; width: number; height: number; type: string; createdAt: number }
interface ThumbnailMetadata {
  sourceWidth: number;
  sourceHeight: number;
  sourceBytes: number;
  sourceEtag: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
  scale: ThumbnailScale;
}

export class ResourceFetchError extends Error {
  constructor(message = 'resource-fetch-failed', options?: ErrorOptions) { super(message, options); this.name = 'ResourceFetchError'; }
}
function finitePositive(value: number): boolean { return Number.isFinite(value) && value > 0; }
export function validateRenderBounds(crop: RenderCrop, imageWidth: number, imageHeight: number): boolean {
  if (![crop.centerX, crop.centerY, crop.width, crop.height, crop.rotationDegrees, imageWidth, imageHeight].every(Number.isFinite)
    || crop.width <= 0 || crop.height <= 0 || imageWidth <= 0 || imageHeight <= 0) return false;
  const angle = crop.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(angle); const sine = Math.sin(angle);
  const halfWidth = crop.width / 2; const halfHeight = crop.height / 2;
  return ([[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]] as const)
    .every(([x, y]) => {
      const sourceX = crop.centerX + x * cosine - y * sine;
      const sourceY = crop.centerY + x * sine + y * cosine;
      return sourceX >= 0 && sourceY >= 0 && sourceX <= imageWidth && sourceY <= imageHeight;
    });
}

function uint24le(bytes: Uint8Array, offset: number): number { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }
function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x01) { offset += 2; continue; }
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (marker === 0xe1 && length >= 16 && String.fromCharCode(...bytes.subarray(offset + 4, offset + 10)) === 'Exif\0\0') {
      const tiff = offset + 10; const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
      if (!(little || bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return 1;
      const get16 = (at: number) => view.getUint16(at, little); const get32 = (at: number) => view.getUint32(at, little);
      if (get16(tiff + 2) !== 42) return 1;
      const ifd = tiff + get32(tiff + 4); if (ifd + 2 > bytes.length) return 1;
      const count = get16(ifd);
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12; if (entry + 12 > bytes.length) break;
        if (get16(entry) === 0x0112 && get16(entry + 2) === 3 && get32(entry + 4) >= 1) return get16(entry + 8);
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}
export function imageHeaderDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 10 && (String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF89a' || String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF87a')) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length >= 30 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === 'VP8X') return { width: 1 + uint24le(bytes, 24), height: 1 + uint24le(bytes, 27) };
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const width = view.getUint16(offset + 7); const height = view.getUint16(offset + 5);
        return [5, 6, 7, 8].includes(jpegOrientation(bytes)) ? { width: height, height: width } : { width, height };
      }
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = view.getUint16(offset + 2); if (length < 2) return null; offset += 2 + length;
    }
  }
  return null;
}
export function assertDecodedLimits(width: number, height: number): void {
  if (!finitePositive(width) || !finitePositive(height) || width > MAX_DECODED_DIMENSION || height > MAX_DECODED_DIMENSION || width * height > MAX_DECODED_PIXELS) throw new Error('decoded-image-too-large');
}
function aborted(): DOMException { return new DOMException('The operation was aborted', 'AbortError'); }
function transportFailure(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw aborted();
  if (error instanceof ResourceFetchError) throw error;
  throw new ResourceFetchError('resource-fetch-failed', { cause: error });
}
async function fetchResource(fetcher: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try { return await fetcher(url, init); } catch (error) { transportFailure(error, signal); }
}
function assertOk(response: Response): void { if (!response.ok) throw new ResourceFetchError(`resource-fetch-failed:${response.status}`); }
function contentLength(response: Response): number | null {
  const raw = response.headers.get('Content-Length'); if (raw === null) return null;
  const value = Number(raw); return Number.isFinite(value) && value >= 0 ? value : null;
}
async function boundedBlob(response: Response, limit: number, signal?: AbortSignal): Promise<Blob> {
  assertOk(response); const length = contentLength(response); if (length !== null && length > limit) throw new Error('source-too-large');
  if (signal?.aborted) throw aborted();
  if (!response.body) { const blob = await response.blob(); if (blob.size > limit) throw new Error('source-too-large'); return blob; }
  const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let total = 0;
  const cancel = () => { void reader.cancel(aborted()).catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await reader.read(); } catch (error) { transportFailure(error, signal); }
      if (signal?.aborted) throw aborted(); if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) { await reader.cancel('source-too-large'); throw new Error('source-too-large'); }
      const copy = new Uint8Array(result.value.byteLength); copy.set(result.value); chunks.push(copy);
    }
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get('Content-Type') ?? 'application/octet-stream' });
}

/** Full originals are intentionally available only to explicit studio editing. */
export async function loadBoundedSource(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Blob> {
  const head = await fetchResource(fetcher, url, { method: 'HEAD', signal }, signal); assertOk(head);
  const length = contentLength(head); if (length !== null && length > MAX_SOURCE_BYTES) throw new Error('source-too-large');
  const response = await fetchResource(fetcher, url, { method: 'GET', signal }, signal);
  const blob = await boundedBlob(response, MAX_SOURCE_BYTES, signal);
  const header = imageHeaderDimensions(new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer()));
  if (header) assertDecodedLimits(header.width, header.height);
  return blob;
}
async function defaultDecode(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') { const bitmap = await createImageBitmap(blob); return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }; }
  if (typeof document === 'undefined' || typeof Image === 'undefined') throw new Error('browser-image-decoder-unavailable');
  const temporaryUrl = URL.createObjectURL(blob); const image = new Image();
  try { image.src = temporaryUrl; if (typeof image.decode === 'function') await image.decode(); else await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('image-decode-failed')); }); return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(temporaryUrl) }; }
  catch (error) { URL.revokeObjectURL(temporaryUrl); throw error; }
}
function defaultCanvas(width: number, height: number): RenderCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height); const context = canvas.getContext('2d'); if (!context) throw new Error('canvas-2d-unavailable');
    return { width, height, context, toBlob: async () => { try { return await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 }); } catch { return canvas.convertToBlob({ type: 'image/png' }); } } };
  }
  if (typeof document === 'undefined') throw new Error('canvas-2d-unavailable');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); if (!context) throw new Error('canvas-2d-unavailable');
  return { width, height, context, toBlob: () => new Promise<Blob>((resolve, reject) => { const png = () => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('canvas-encode-failed')), 'image/png'); try { canvas.toBlob((blob) => blob ? resolve(blob) : png(), 'image/webp', 0.86); } catch { png(); } }) };
}
const defaults: RendererDependencies = { fetcher: (...args) => fetch(...args), decode: defaultDecode, makeCanvas: defaultCanvas, createObjectURL: (blob) => URL.createObjectURL(blob), revokeObjectURL: (url) => URL.revokeObjectURL(url), now: () => Date.now() };
function positiveInteger(headers: Headers, name: string): number {
  const raw = headers.get(name); const value = raw === null ? NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw?.trim()) throw new Error('invalid-thumbnail-metadata');
  return value;
}
function metadata(response: Response, expectedScale: ThumbnailScale): ThumbnailMetadata {
  assertOk(response);
  const sourceWidth = positiveInteger(response.headers, 'X-Source-Width');
  const sourceHeight = positiveInteger(response.headers, 'X-Source-Height');
  const sourceBytes = positiveInteger(response.headers, 'X-Source-Bytes');
  const thumbnailWidth = positiveInteger(response.headers, 'X-Thumbnail-Width');
  const thumbnailHeight = positiveInteger(response.headers, 'X-Thumbnail-Height');
  const scale = Number(response.headers.get('X-Thumbnail-Scale')) as ThumbnailScale;
  const sourceEtag = response.headers.get('X-Source-ETag')?.trim() ?? '';
  if (scale !== expectedScale || !sourceEtag || thumbnailWidth !== Math.max(1, Math.floor(sourceWidth * scale)) || thumbnailHeight !== Math.max(1, Math.floor(sourceHeight * scale))) throw new Error('invalid-thumbnail-metadata');
  return { sourceWidth, sourceHeight, sourceBytes, sourceEtag, thumbnailWidth, thumbnailHeight, scale };
}

export class BrowserImageRenderer {
  private readonly dependencies: RendererDependencies;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly issuedUrls = new Set<string>();
  private cacheBytes = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(dependencies: Partial<RendererDependencies> = {}) { this.dependencies = { ...defaults, ...dependencies }; }

  async render(request: RenderRequest): Promise<RenderedImage> {
    const maxDimension = request.maxDimension ?? DEFAULT_RENDER_DIMENSION;
    if (!finitePositive(maxDimension)) throw new Error('invalid-max-dimension');
    if (request.signal?.aborted) throw aborted(); this.pruneExpired();
    const preflight = await fetchResource(this.dependencies.fetcher, thumbnailUrl(request.virtualPath, METADATA_SCALE), { method: 'HEAD', signal: request.signal }, request.signal);
    const source = metadata(preflight, METADATA_SCALE); if (request.signal?.aborted) throw aborted();
    if (request.crop && !validateRenderBounds(request.crop, source.sourceWidth, source.sourceHeight)) throw new Error('invalid-crop-rectangle');
    const scale = selectThumbnailScale({ sourceWidth: source.sourceWidth, sourceHeight: source.sourceHeight, sourceBytes: source.sourceBytes, crop: request.crop, maxDimension });
    const geometry = request.crop ? [request.crop.centerX, request.crop.centerY, request.crop.width, request.crop.height, request.crop.rotationDegrees].join(',') : 'full';
    const key = `${request.virtualPath}\0${source.sourceEtag}\0${scale}\0${geometry}\0${maxDimension}`;
    this.removeStalePathEntries(request.virtualPath, source.sourceEtag);
    const cached = this.cache.get(key);
    if (cached && this.dependencies.now() - cached.createdAt <= CACHE_TTL_MS) { this.touch(key, cached); return this.issue(cached); }
    if (cached) this.removeEntry(key, cached);
    const result = await this.renderFresh(request.virtualPath, source, scale, request.crop, maxDimension, request.signal);
    if (request.signal?.aborted) throw aborted();
    const previous = this.cache.get(key);
    if (previous) { this.touch(key, previous); return this.issue(previous); }
    const entry: CacheEntry = { ...result, createdAt: this.dependencies.now() }; this.cache.set(key, entry); this.cacheBytes += entry.blob.size; this.trim(); this.scheduleExpiry(); return this.issue(entry);
  }
  release(result: RenderedImage): void { if (this.issuedUrls.delete(result.url)) this.dependencies.revokeObjectURL(result.url); }
  dispose(): void { for (const url of this.issuedUrls) this.dependencies.revokeObjectURL(url); this.issuedUrls.clear(); this.cache.clear(); this.cacheBytes = 0; if (this.expiryTimer !== null) clearTimeout(this.expiryTimer); this.expiryTimer = null; }

  private async renderFresh(path: string, source: ThumbnailMetadata, scale: ThumbnailScale, crop: RenderCrop | undefined, maxDimension: number, signal?: AbortSignal): Promise<Omit<CacheEntry, 'createdAt'>> {
    const response = await fetchResource(this.dependencies.fetcher, thumbnailUrl(path, scale), { method: 'GET', signal }, signal);
    const actual = metadata(response, scale);
    if (actual.sourceWidth !== source.sourceWidth || actual.sourceHeight !== source.sourceHeight || actual.sourceBytes !== source.sourceBytes || actual.sourceEtag !== source.sourceEtag) throw new Error('thumbnail-source-changed');
    const blob = await boundedBlob(response, MAX_THUMBNAIL_BYTES, signal); const decoded = await this.dependencies.decode(blob);
    try {
      if (signal?.aborted) throw aborted();
      if (decoded.width !== actual.thumbnailWidth || decoded.height !== actual.thumbnailHeight) throw new Error('thumbnail-dimensions-mismatch');
      const logicalWidth = crop?.width ?? source.sourceWidth; const logicalHeight = crop?.height ?? source.sourceHeight;
      const ratio = Math.min(1, maxDimension / Math.max(logicalWidth, logicalHeight));
      const width = Math.max(1, Math.round(logicalWidth * ratio)); const height = Math.max(1, Math.round(logicalHeight * ratio));
      const canvas = this.dependencies.makeCanvas(width, height);
      if (crop) {
        canvas.context.translate(width / 2, height / 2); canvas.context.rotate(-crop.rotationDegrees * Math.PI / 180);
        canvas.context.scale(width / crop.width, height / crop.height); canvas.context.translate(-crop.centerX, -crop.centerY);
        // The relay is already EXIF-normalized. Paint its small bitmap into the original logical coordinate system.
        canvas.context.drawImage(decoded.source, 0, 0, source.sourceWidth, source.sourceHeight);
      } else canvas.context.drawImage(decoded.source, 0, 0, width, height);
      const output = await canvas.toBlob(); if (signal?.aborted) throw aborted();
      if (output.type !== 'image/webp' && output.type !== 'image/png') throw new Error('unsupported-canvas-output');
      return { blob: output, width, height, type: output.type };
    } finally { decoded.close(); }
  }
  private touch(key: string, entry: CacheEntry): void { this.cache.delete(key); this.cache.set(key, entry); }
  private removeStalePathEntries(path: string, identity: string): void { const prefix = `${path}\0`; const current = `${prefix}${identity}\0`; for (const [key, entry] of this.cache) if (key.startsWith(prefix) && !key.startsWith(current)) this.removeEntry(key, entry); }
  private trim(): void { while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheBytes > MAX_CACHE_BYTES) { const key = this.cache.keys().next().value as string; this.removeEntry(key, this.cache.get(key)!); } }
  private removeEntry(key: string, entry: CacheEntry): void { this.cache.delete(key); this.cacheBytes -= entry.blob.size; }
  private pruneExpired(): void { const now = this.dependencies.now(); for (const [key, entry] of this.cache) if (now - entry.createdAt >= CACHE_TTL_MS) this.removeEntry(key, entry); this.scheduleExpiry(); }
  private scheduleExpiry(): void { if (this.expiryTimer !== null) clearTimeout(this.expiryTimer); this.expiryTimer = null; let expiresAt = Infinity; for (const entry of this.cache.values()) expiresAt = Math.min(expiresAt, entry.createdAt + CACHE_TTL_MS); if (!Number.isFinite(expiresAt)) return; this.expiryTimer = setTimeout(() => { this.expiryTimer = null; this.pruneExpired(); }, Math.max(0, expiresAt - this.dependencies.now())); }
  private issue(entry: Pick<CacheEntry, 'blob' | 'width' | 'height' | 'type'>): RenderedImage { const url = this.dependencies.createObjectURL(entry.blob); this.issuedUrls.add(url); return { url, width: entry.width, height: entry.height, type: entry.type }; }
}
export const browserImageRenderer = new BrowserImageRenderer();
