// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Optional live acceptance harness for the thumbnail relay.  It deliberately
 * uses a generated, private /tmp fixture and the built SPA: it never opens the
 * application's configured resource or data directories.
 *
 * Required environment: PLAYWRIGHT_MODULE and CHROMIUM_PATH.  PYTHON defaults
 * to app/backend/.venv/bin/python and may be overridden for CI.
 */
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const frontend = path.resolve(import.meta.dirname, '..');
const repository = path.resolve(frontend, '..', '..');
const backend = path.join(repository, 'app/backend');
const python = process.env.PYTHON ?? path.join(backend, '.venv/bin/python');
const playwrightLocation = process.env.PLAYWRIGHT_MODULE;
if (!playwrightLocation) throw new Error('PLAYWRIGHT_MODULE must point to Playwright');
const playwrightEntry = (await stat(playwrightLocation)).isDirectory() ? path.join(playwrightLocation, 'index.mjs') : playwrightLocation;
const chromiumPath = process.env.CHROMIUM_PATH;
if (!chromiumPath) throw new Error('CHROMIUM_PATH must point to Chromium');
await Promise.all([access(python), access(playwrightEntry), access(chromiumPath), access(path.join(frontend, 'build', 'index.html'))]);
const { chromium } = await import(pathToFileURL(playwrightEntry).href);

const root = await mkdtemp(path.join(tmpdir(), 'flightarchive-thumbnail-relay-'));
const resources = path.join(root, 'resources');
const runtime = path.join(root, 'runtime');
const cache = path.join(root, 'cache');
const staticDir = path.join(frontend, 'build');
const port = 43000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const sourcePath = 'nested/航 班/100%#scan.jpg';
const pngPath = 'nested/PNG scan.png';
let server;
let browserMetrics;

function run(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  return Object.assign(child, { output: () => output });
}
async function waitFor(url, child) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${child.output()}`);
    try { if ((await fetch(url)).ok) return; } catch { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become ready\n${child.output()}`);
}
async function request(pathname, init) {
  const response = await fetch(`${origin}${pathname}`, init);
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${pathname}: ${response.status} ${await response.text()}`);
  return response;
}
function elapsed(action) {
  const started = performance.now();
  return Promise.resolve(action()).then((value) => ({ value, milliseconds: performance.now() - started }));
}

// Kept inline so the harness has no fixture files to accidentally ship.  The
// JPEG has 12.25M noisy pixels expanded to 140MP, making it a realistic large
// scan while avoiding an unbounded JavaScript allocation.
const generator = String.raw`
from pathlib import Path
from PIL import Image, ImageDraw
import os, sys
root = Path(sys.argv[1]); r = root / 'resources'; r.mkdir(parents=True)
base = Image.effect_noise((3500, 2500), 80).convert('L')
image = base.resize((14000, 10000), Image.Resampling.NEAREST)
target = r / 'large-source.jpg'; image.save(target, 'JPEG', quality=95, optimize=False)
base.close(); image.close()
if not (24 * 1024 * 1024 < target.stat().st_size <= 256 * 1024 * 1024):
    raise SystemExit(f'JPEG size outside acceptance range: {target.stat().st_size}')
# A separate 35MP PNG exercises the non-JPEG cold path one image at a time.
png = Image.new('RGB', (7000, 5000), '#245b88'); draw = ImageDraw.Draw(png)
for y in range(0, 5000, 125): draw.line((0, y, 7000, y), fill='#d7a42f', width=8)
png.save(r / 'large-source.png', 'PNG', optimize=False); png.close()
for i in range(8): os.link(target, r / f'copy-{i}.jpg')
`;

try {
  const generated = run(python, ['-c', generator, root]);
  await once(generated, 'exit');
  if (generated.exitCode !== 0) throw new Error(`fixture generator failed\n${generated.output()}`);
  server = run(python, ['-m', 'flightarchive', '--host', '127.0.0.1', '--port', String(port), '--resource-root', resources, '--data-root', runtime, '--static-dir', staticDir], {
    cwd: backend,
    env: { ...process.env, RFG_RESOURCE_PATH: resources, RFG_DATA_DIR: runtime, FLIGHTARCHIVE_CACHE_DIR: cache, FLIGHTARCHIVE_STATIC_DIR: staticDir },
  });
  await waitFor(`${origin}/api/healthz`, server);

  const mappings = [{ virtual_path: sourcePath, local_path: 'large-source.jpg' }, { virtual_path: pngPath, local_path: 'large-source.png' }];
  for (let index = 0; index < 8; index += 1) mappings.push({ virtual_path: `scan/${index}.jpg`, local_path: `copy-${index}.jpg` });
  await request('/api/v1/meta/map', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: mappings }) });
  const map = await request('/api/v1/meta/map'); assert.equal((await map.json()).entries.length, mappings.length);

  const now = '2026-01-01T00:00:00.000Z';
  const crop = { centerX: 7000, centerY: 5000, width: 11200, height: 4200, rotationDegrees: -8 };
  const layout = { schemaVersion: 1, algorithm: 'adaptive', crop, templateId: 'bp-247.svg', placement: { scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0 } };
  const flights = Array.from({ length: 92 }, (_, index) => ({
    id: `fixture-${index}`, flightNumber: String(100 + index), airlineCode: 'CA', departureAirport: 'PEK', arrivalAirport: 'PVG', departureTerminal: null, arrivalTerminal: null,
    departureDate: '2026-01-01', departureTime: '12:00', arrivalTime: null, aircraftTypeIcao: 'A320', registration: null, seat: '1A', notes: '', createdAt: now, updatedAt: now,
    paperBoardingPassFrontResourcePath: index === 0 ? sourcePath : `scan/${index % 8}.jpg`, paperBoardingPassBackResourcePath: pngPath, electronicBoardingPassResourcePath: null,
    attachmentResourcePaths: [], paperBoardingPassLayouts: { paperBoardingPassFront: layout, paperBoardingPassBack: layout }, electronicBoardingPass: null, boardingPassColor: null,
  }));
  await request('/api/archive/flightarchive/documents/flights.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(flights) });
  const persistedFlights = await request('/api/archive/flightarchive/documents/flights.json').then((response) => response.json());
  assert.equal(persistedFlights.length, 92);
  assert(!Object.hasOwn(persistedFlights[0], 'sourcePath') && !Object.hasOwn(persistedFlights[0], 'scale'), 'fixture stored a forbidden source or scale field');

  const encoded = encodeURIComponent(sourcePath).replace(/%2F/g, '/');
  const thumbnail = `/api/thumbnails/${encoded}?scale=0.015625`;
  const head = await request(thumbnail, { method: 'HEAD' });
  assert.equal(head.headers.get('x-source-width'), '14000'); assert.equal(head.headers.get('x-source-height'), '10000');
  const sourceBytes = Number(head.headers.get('x-source-bytes'));
  assert(sourceBytes > 24 * 1024 * 1024 && sourceBytes <= 256 * 1024 * 1024, `source bytes ${sourceBytes}`);
  const cold = await elapsed(() => request(thumbnail).then(async (response) => ({ bytes: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get('etag'), width: response.headers.get('x-thumbnail-width'), height: response.headers.get('x-thumbnail-height') })));
  assert.equal(cold.value.width, '218'); assert.equal(cold.value.height, '156'); assert(cold.value.bytes.byteLength <= 4 * 1024 * 1024);
  const hot = await elapsed(() => request(thumbnail).then(async (response) => ({ bytes: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get('etag') })));
  assert.deepEqual(hot.value.bytes, cold.value.bytes); assert.equal(hot.value.etag, cold.value.etag);
  const pngEncoded = encodeURIComponent(pngPath).replace(/%2F/g, '/');
  const pngCold = await elapsed(() => request(`/api/thumbnails/${pngEncoded}?scale=0.015625`).then((r) => r.arrayBuffer()));
  const pngHot = await elapsed(() => request(`/api/thumbnails/${pngEncoded}?scale=0.015625`).then((r) => r.arrayBuffer()));
  const ranged = await request(`/res/${encoded}`, { headers: { Range: 'bytes=0-0' } }); assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 1);

  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = []; const relay = []; const originals = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); }); page.on('pageerror', (error) => errors.push(String(error)));
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/thumbnails/')) relay.push({ url: response.url(), size: Number(response.headers()['content-length'] ?? 0) });
    if (url.pathname.startsWith('/res/')) originals.push(response.url());
  });
  try {
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.locator('button[aria-label="Card Grid View"], button[aria-label="卡片网格视图"]').click();
    await page.waitForTimeout(1500);
    const firstPreview = await page.locator('img[alt="Paper Front"], img[alt="纸质正面"]').first().evaluate((image) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }));
    assert(firstPreview.complete && firstPreview.width > 0 && firstPreview.height > 0, 'first preview did not decode');
    assert.equal(await page.getByText(/preview unavailable/i).count(), 0, 'preview fallback displayed');
    const beforeScroll = relay.length; assert(beforeScroll > 0 && beforeScroll < 184, `viewport relay count ${beforeScroll}`);
    await page.mouse.wheel(0, 8000); await page.waitForTimeout(1000); assert(relay.length > beforeScroll, 'scroll did not request deferred previews');
    await page.locator('[role="button"]').filter({ hasText: 'CA100' }).first().click(); await page.waitForTimeout(600);
    assert(await page.getByRole('dialog').count() > 0, 'flight detail did not open');
    assert.equal(originals.length, 0, `ordinary browse fetched original resources: ${originals.join(', ')}`);
    assert(relay.every((item) => item.size === 0 || item.size <= 4 * 1024 * 1024), 'browser received an oversized relay payload');
    assert.equal(errors.length, 0, errors.join('\n'));
    browserMetrics = { initialRelayRequests: beforeScroll, relayRequestsAfterScroll: relay.length, originalResourceRequests: originals.length, consoleOrPageErrors: errors.length };
  } finally { await page.close(); await browser.close(); }
  const cacheFiles = await readdir(cache);
  assert(cacheFiles.some((name) => name.endsWith('.webp')) && cacheFiles.some((name) => name.endsWith('.json')), 'relay cache files were not written');
  console.log(JSON.stringify({ source: { bytes: sourceBytes, dimensions: '14000x10000' }, jpeg: { thumbnail: `${cold.value.width}x${cold.value.height}`, encodedBytes: cold.value.bytes.byteLength, coldMs: Math.round(cold.milliseconds), warmMs: Math.round(hot.milliseconds) }, png: { dimensions: '7000x5000', coldMs: Math.round(pngCold.milliseconds), warmMs: Math.round(pngHot.milliseconds) }, browser: browserMetrics, cacheFiles: cacheFiles.length, result: 'passed' }, null, 2));
} finally {
  if (server?.exitCode === null) { server.kill('SIGTERM'); await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]); }
  await rm(root, { recursive: true, force: true });
}
