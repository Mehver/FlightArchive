// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Real-Chromium contract test for relay-only raster display. The relay is
 * mocked with genuinely small WebP derivatives plus original logical headers;
 * this does not claim to benchmark the live Pillow/backend path. */
import assert from 'node:assert/strict';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const playwrightLocation = process.env.PLAYWRIGHT_MODULE;
if (!playwrightLocation) throw new Error('PLAYWRIGHT_MODULE must point to Playwright');
const playwrightEntry = (await stat(playwrightLocation)).isDirectory() ? path.join(playwrightLocation, 'index.mjs') : playwrightLocation;
await access(playwrightEntry);
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const executablePath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium';
await access(executablePath);
const port = Number(process.env.BROWSER_TEST_PORT ?? 41739);
const origin = `http://127.0.0.1:${port}`;
const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '--no-experimental-webstorage' },
});
let viteOutput = '';
vite.stdout.on('data', (chunk) => { viteOutput += String(chunk); }); vite.stderr.on('data', (chunk) => { viteOutput += String(chunk); });
async function waitForVite() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early (${vite.exitCode})\n${viteOutput}`);
    try { if ((await fetch(`${origin}/@vite/client`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for Vite\n${viteOutput}`);
}
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const resources = new Map(); const relayGets = new Map(); const originalGets = new Map();
try {
  await waitForVite();
  await page.route('**/api/thumbnails/**', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const virtualPath = decodeURIComponent(url.pathname.slice('/api/thumbnails/'.length)); const scale = Number(url.searchParams.get('scale'));
    const resource = resources.get(virtualPath); if (!resource) return route.fulfill({ status: 404, body: 'missing' });
    const derivative = resource.derivatives.get(scale); if (!derivative) return route.fulfill({ status: 400, body: 'unsupported fixture scale' });
    const headers = {
      'Content-Type': 'image/webp', 'X-Source-Width': String(resource.width), 'X-Source-Height': String(resource.height),
      'X-Source-Bytes': String(resource.sourceBytes), 'X-Source-ETag': resource.etag,
      'X-Thumbnail-Width': String(derivative.width), 'X-Thumbnail-Height': String(derivative.height), 'X-Thumbnail-Scale': String(scale),
    };
    if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers });
    relayGets.set(`${virtualPath}@${scale}`, (relayGets.get(`${virtualPath}@${scale}`) ?? 0) + 1);
    if (resource.delay) await new Promise((resolve) => setTimeout(resolve, resource.delay));
    return route.fulfill({ status: 200, headers, body: Buffer.from(derivative.bytes) });
  });
  await page.route('**/res/**', async (route) => {
    const request = route.request(); const virtualPath = decodeURIComponent(new URL(request.url()).pathname.slice('/res/'.length));
    const resource = resources.get(virtualPath); if (!resource?.original) return route.fulfill({ status: 404, body: 'no original fixture' });
    if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'Content-Length': String(resource.original.bytes.length), 'Content-Type': resource.original.type } });
    originalGets.set(virtualPath, (originalGets.get(virtualPath) ?? 0) + 1);
    return route.fulfill({ status: 200, contentType: resource.original.type, body: Buffer.from(resource.original.bytes) });
  });
  await page.goto(`${origin}/@vite/client`);
  await page.evaluate(async () => { globalThis.__browserImageModule = await import('/src/resources/browserImageRenderer.ts'); });
  const fixtures = await page.evaluate(async () => {
    async function encode(width, height, type = 'image/webp', oriented = false) {
      const canvas = new OffscreenCanvas(width, height); const context = canvas.getContext('2d');
      const colors = oriented ? ['#0000ff', '#ff0000', '#ffff00', '#00ff00'] : ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
      for (let index = 0; index < 4; index += 1) { context.fillStyle = colors[index]; context.fillRect(index % 2 ? width / 2 : 0, index > 1 ? height / 2 : 0, width / 2, height / 2); }
      const blob = await canvas.convertToBlob({ type, quality: 0.9 }); return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), type: blob.type, width, height };
    }
    return {
      original: await encode(800, 600, 'image/png'), half: await encode(400, 300), full: await encode(800, 600),
      largeSixteenth: await encode(875, 625), largeEighth: await encode(1750, 1250), orientedHalf: await encode(300, 400, 'image/webp', true), orientedFull: await encode(600, 800, 'image/webp', true),
      tinyNormal: await encode(12, 9), tinyLarge: await encode(218, 156), tinyOriented: await encode(9, 12),
    };
  });
  const scales = (pairs) => new Map(pairs);
  for (const name of ['png.img', 'jpeg.img', 'webp.img']) resources.set(name, { width: 800, height: 600, sourceBytes: 100_000, etag: `"${name}"`, original: fixtures.original, derivatives: scales([[0.015625, fixtures.tinyNormal], [0.5, fixtures.half], [1, fixtures.full]]) });
  resources.set('large.jpg', { width: 14_000, height: 10_000, sourceBytes: 500_000, etag: '"large"', derivatives: scales([[0.015625, fixtures.tinyLarge], [0.0625, fixtures.largeSixteenth], [0.125, fixtures.largeEighth]]) });
  resources.set('oriented.jpg', { width: 600, height: 800, sourceBytes: 100_000, etag: '"oriented"', derivatives: scales([[0.015625, fixtures.tinyOriented], [0.5, fixtures.orientedHalf], [1, fixtures.orientedFull]]) });
  resources.set('cancel.img', { ...resources.get('png.img'), etag: '"cancel"', delay: 250 });

  const formats = await page.evaluate(async () => {
    const { BrowserImageRenderer } = globalThis.__browserImageModule; const renderer = new BrowserImageRenderer(); const output = [];
    for (const virtualPath of ['png.img', 'jpeg.img', 'webp.img']) { const result = await renderer.render({ virtualPath }); const bitmap = await createImageBitmap(await (await fetch(result.url)).blob()); output.push([bitmap.width, bitmap.height]); bitmap.close(); renderer.release(result); }
    renderer.dispose(); return output;
  });
  assert.deepEqual(formats, [[512, 384], [512, 384], [512, 384]]);
  assert.equal([...originalGets.values()].reduce((sum, count) => sum + count, 0), 0, 'raster display fetched an original');

  const crop = await page.evaluate(async () => {
    const { BrowserImageRenderer } = globalThis.__browserImageModule; const renderer = new BrowserImageRenderer();
    const result = await renderer.render({ virtualPath: 'png.img', crop: { centerX: 400, centerY: 300, width: 400, height: 200, rotationDegrees: 90 }, maxDimension: 512 });
    const bitmap = await createImageBitmap(await (await fetch(result.url)).blob()); const canvas = new OffscreenCanvas(bitmap.width, bitmap.height); const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
    const points = [[10,10],[bitmap.width-11,10],[bitmap.width-11,bitmap.height-11],[10,bitmap.height-11]]; const pixels = points.map(([x,y]) => Array.from(context.getImageData(x,y,1,1).data.slice(0,3)));
    bitmap.close(); renderer.dispose(); return { width: result.width, height: result.height, pixels };
  });
  assert.deepEqual([crop.width, crop.height], [400, 200]);
  const dominant = crop.pixels.map((rgb) => rgb.indexOf(Math.max(...rgb))); assert.deepEqual(dominant, [1, 0, 2, 0]);

  const large = await page.evaluate(async () => { const { BrowserImageRenderer } = globalThis.__browserImageModule; const renderer = new BrowserImageRenderer(); const result = await renderer.render({ virtualPath: 'large.jpg', crop: { centerX: 7260.99, centerY: 4927.5, width: 9540.97, height: 3897.07, rotationDegrees: -8 }, maxDimension: 1024 }); renderer.dispose(); return { width: result.width, height: result.height }; });
  assert.deepEqual(large, { width: 1024, height: 418 }); assert.equal(relayGets.get('large.jpg@0.125'), 1);

  const oriented = await page.evaluate(async () => { const { BrowserImageRenderer } = globalThis.__browserImageModule; const renderer = new BrowserImageRenderer(); const result = await renderer.render({ virtualPath: 'oriented.jpg' }); const bitmap = await createImageBitmap(await (await fetch(result.url)).blob()); const dimensions = [bitmap.width, bitmap.height]; bitmap.close(); renderer.dispose(); return dimensions; });
  assert.deepEqual(oriented, [384, 512]);

  await page.evaluate(async () => { const { BrowserImageRenderer } = globalThis.__browserImageModule; const renderer = new BrowserImageRenderer(); const one = await renderer.render({ virtualPath: 'png.img' }); const two = await renderer.render({ virtualPath: 'png.img' }); renderer.release(one); renderer.release(two); renderer.dispose(); });
  assert.equal(relayGets.get('png.img@1'), 4); // Mock routing disables native HTTP caching; there is intentionally no renderer LRU.

  const cancelled = page.evaluate(async () => { const { BrowserImageRenderer } = globalThis.__browserImageModule; const renderer = new BrowserImageRenderer(); const controller = new AbortController(); const pending = renderer.render({ virtualPath: 'cancel.img', signal: controller.signal }); setTimeout(() => controller.abort(), 25); try { await pending; return ''; } catch (error) { return error.name; } finally { renderer.dispose(); } });
  assert.equal(await cancelled, 'AbortError');

  const studio = await page.evaluate(async () => { const { loadStudioSource } = globalThis.__browserImageModule; const source = await loadStudioSource('large.jpg'); const bitmap = await createImageBitmap(source.blob); const dimensions = [bitmap.width, bitmap.height, source.sourceWidth, source.sourceHeight]; bitmap.close(); return dimensions; });
  assert.deepEqual(studio, [1750, 1250, 14000, 10000]); assert.equal(originalGets.get('large.jpg') ?? 0, 0);
  console.log(`browserImages: Chromium ${await browser.version()} passed small relay WebP decode, original-coordinate crop, EXIF-normalized logical geometry, 14000x10000 bounded Studio scaling, no renderer LRU, cancellation, and zero raster /res requests (mock relay; not a live-backend benchmark)`);
} finally {
  await page.close().catch(() => undefined); await browser.close().catch(() => undefined); vite.kill('SIGTERM');
  await new Promise((resolve) => { if (vite.exitCode !== null) resolve(); else { vite.once('exit', resolve); setTimeout(resolve, 2000); } });
}
