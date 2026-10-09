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
Image.new('RGB', (320, 180), '#b02020').save(r / 'cache-first.png', 'PNG')
Image.new('RGB', (640, 360), '#2050b0').save(r / 'cache-second.png', 'PNG')
channels = [Image.effect_noise((2000, 2000), 100).convert('L') for _ in range(4)]
entropy = Image.merge('RGBA', tuple(channels)); entropy.save(r / 'entropy-alpha.png', 'PNG', optimize=False)
entropy.close()
for channel in channels: channel.close()
os.link(target, r / 'logo-source.jpg')
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

  const cacheProbePath = 'cache/probe.png';
  const entropyPath = 'studio/entropy-alpha.png'; const logoPath = 'logos/slow.png';
  const mappings = [{ virtual_path: sourcePath, local_path: 'large-source.jpg' }, { virtual_path: pngPath, local_path: 'large-source.png' }, { virtual_path: cacheProbePath, local_path: 'cache-first.png' }, { virtual_path: entropyPath, local_path: 'entropy-alpha.png' }, { virtual_path: logoPath, local_path: 'logo-source.jpg' }];
  for (let index = 0; index < 8; index += 1) mappings.push({ virtual_path: `scan/${index}.jpg`, local_path: `copy-${index}.jpg` });
  await request('/api/v1/meta/map', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: mappings }) });
  const map = await request('/api/v1/meta/map'); assert.equal((await map.json()).entries.length, mappings.length);

  const now = '2026-01-01T00:00:00.000Z';
  const crop = { centerX: 7000, centerY: 5000, width: 11200, height: 4200, rotationDegrees: -8 };
  const backCrop = { centerX: 3500, centerY: 2500, width: 5600, height: 2100, rotationDegrees: -8 };
  const layout = { schemaVersion: 1, algorithm: 'adaptive', crop, templateId: 'bp-247.svg', placement: { scale: 1, rotationDegrees: 7, offsetX: 0.04, offsetY: -0.03 } };
  const backLayout = { ...layout, crop: backCrop };
  const entropyCrop = { centerX: 1000, centerY: 1000, width: 1500, height: 700, rotationDegrees: 11 };
  const entropyLayout = { ...layout, crop: entropyCrop };
  const electronicCrop = { centerX: 7000, centerY: 5000, width: 4000, height: 6000, mirrorAcrossImageCenterX: false };
  const flights = Array.from({ length: 92 }, (_, index) => ({
    id: `fixture-${index}`, flightNumber: String(100 + index), airlineCode: 'CA', departureAirport: 'PEK', arrivalAirport: 'PVG', departureTerminal: null, arrivalTerminal: null,
    departureDate: '2026-01-01', departureTime: '12:00', arrivalTime: null, aircraftTypeIcao: 'A320', registration: null, seat: '1A', notes: '', createdAt: now, updatedAt: now,
    paperBoardingPassFrontResourcePath: index === 0 ? sourcePath : index === 1 ? entropyPath : `scan/${index % 8}.jpg`, paperBoardingPassBackResourcePath: pngPath, electronicBoardingPassResourcePath: index === 0 ? sourcePath : null,
    attachmentResourcePaths: [], paperBoardingPassLayouts: { paperBoardingPassFront: index === 1 ? entropyLayout : layout, paperBoardingPassBack: backLayout }, electronicBoardingPass: index === 0 ? { schemaVersion: 1, extraction: { crop: electronicCrop, presetName: 'Large fixture' } } : null, boardingPassColor: index === 0 ? '#123456' : null,
  }));
  await request('/api/archive/flightarchive/documents/flights.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(flights) });
  await request('/api/archive/flightarchive/documents/airlines.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ code: 'CA', icao: 'CCA', nameZh: '中国国航', nameEn: 'Air China', alliance: null, horizontalLogoResourcePath: null, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: logoPath, brandColors: { primary: null, contrast: null } }]) });
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
  const entropyEncoded = encodeURIComponent(entropyPath).replace(/%2F/g, '/');
  const entropyFull = await fetch(`${origin}/api/thumbnails/${entropyEncoded}?scale=1`);
  assert.equal(entropyFull.status, 413); assert.equal((await entropyFull.json()).error.code, 'thumbnail-output-too-large');

  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const cdp = await page.context().newCDPSession(page); await cdp.send('Network.enable');
  const wireUrls = new Map(); const conditionalRequestIds = new Set(); const notModifiedRequestIds = new Set();
  cdp.on('Network.requestWillBeSent', (event) => wireUrls.set(event.requestId, event.request.url));
  cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
    if (Object.keys(event.headers).some((name) => name.toLowerCase() === 'if-none-match')) conditionalRequestIds.add(event.requestId);
  });
  cdp.on('Network.responseReceivedExtraInfo', (event) => { if (event.statusCode === 304) notModifiedRequestIds.add(event.requestId); });
  const errors = []; const relay = []; const relayRequests = []; const originals = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); }); page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/thumbnails/')) relayRequests.push(request.url()); });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/thumbnails/')) relay.push({ url: response.url(), size: Number(response.headers()['content-length'] ?? 0) });
    if (url.pathname.startsWith('/res/')) originals.push(response.url());
  });
  try {
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.locator('button[aria-label="Card Grid View"], button[aria-label="卡片网格视图"]').click();
    assert(await page.locator('[role="progressbar"]:visible').count() > 0, 'visible image loading did not show a progress ring');
    const logoHost = page.getByRole('img', { name: 'Air China' }).first(); await logoHost.waitFor();
    const logoLoading = logoHost.getByTestId('airline-logo-loading'); await logoLoading.waitFor();
    const [hostBox, loaderBox] = await Promise.all([logoHost.boundingBox(), logoLoading.boundingBox()]);
    assert(hostBox && loaderBox && loaderBox.x >= hostBox.x && loaderBox.y >= hostBox.y && loaderBox.x + loaderBox.width <= hostBox.x + hostBox.width && loaderBox.y + loaderBox.height <= hostBox.y + hostBox.height, 'airline logo spinner escaped its host bounds');
    await page.waitForTimeout(1500);
    const firstPreview = await page.locator('img[alt="Paper Front"], img[alt="纸质正面"]').first().evaluate((image) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, src: image.src }));
    assert(firstPreview.complete && firstPreview.width > 0 && firstPreview.height > 0, 'first preview did not decode');
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('[role="progressbar"]')).some((element) => { const style = getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden' && element.getBoundingClientRect().width > 0; }));
    assert.equal(await logoLoading.count(), 0, 'airline logo spinner remained after image load');
    assert.equal(await page.getByText(/preview unavailable/i).count(), 0, 'preview fallback displayed');
    const beforeScroll = relayRequests.length; assert(beforeScroll > 0 && beforeScroll < 184, `viewport relay count ${beforeScroll}`);
    await page.mouse.wheel(0, 8000); await page.waitForTimeout(1000); assert(relayRequests.length > beforeScroll, 'scroll did not request deferred previews');
    const afterDown = relayRequests.length;
    await page.mouse.wheel(0, -8000); await page.waitForTimeout(1000);
    const returnedFirstPreview = await page.locator('img[alt="Paper Front"], img[alt="纸质正面"]').first().evaluate((image) => ({ complete: image.complete, width: image.naturalWidth, src: image.src }));
    assert(returnedFirstPreview.complete && returnedFirstPreview.width > 0, 'returning left the first visible image unloaded');

    // Isolate the one uniquely-bound large source: load its card, move far
    // away, then return. Other cards may legitimately load for the first time.
    const uniqueCard = page.locator('[role="button"]').filter({ hasText: 'CA100' }).first();
    await uniqueCard.scrollIntoViewIfNeeded();
    const uniqueImage = uniqueCard.locator('img[alt="Paper Front"], img[alt="纸质正面"]').first();
    await uniqueImage.waitFor(); await uniqueImage.evaluate((image) => image.decode());
    const uniqueSrc = await uniqueImage.getAttribute('src');
    const uniqueRequests = relayRequests.filter((requestUrl) => decodeURIComponent(new URL(requestUrl).pathname).endsWith(sourcePath)).length;
    await page.locator('[role="button"]').filter({ hasText: 'CA191' }).first().scrollIntoViewIfNeeded(); await page.waitForTimeout(400);
    await uniqueCard.scrollIntoViewIfNeeded(); await page.waitForTimeout(400);
    assert.equal(relayRequests.filter((requestUrl) => decodeURIComponent(new URL(requestUrl).pathname).endsWith(sourcePath)).length, uniqueRequests, 'returning re-requested the already loaded unique card image');
    assert.equal(await uniqueImage.getAttribute('src'), uniqueSrc, 'returning replaced the unique card blob URL');

    // Open the authoritative flight editor and exercise both large-image Studios.
    await page.getByRole('navigation').getByRole('button').nth(1).click();
    await page.getByRole('button', { name: 'Edit Flight' }).first().click();
    const flightDialog = page.getByRole('dialog', { name: 'Edit Flight' }); await flightDialog.waitFor();
    const paperRow = flightDialog.getByText('Paper Front', { exact: true }).locator('..');
    await paperRow.getByRole('button', { name: 'Crop Boarding Pass' }).click();
    const paperStudio = page.getByRole('dialog', { name: /Boarding Pass Layout: Paper Front/ }); await paperStudio.waitFor();
    assert.equal(await paperStudio.getByText(/Could not load the bound image/).count(), 0, 'paper Studio rejected the large image');
    await paperStudio.getByRole('button', { name: /Back.*Detect & Crop/ }).click();
    assert.equal(await paperStudio.getByRole('spinbutton', { name: 'Center X', exact: true }).inputValue(), '7000');
    assert.equal(await paperStudio.getByRole('spinbutton', { name: 'Center Y', exact: true }).inputValue(), '5000');
    assert.equal(await paperStudio.getByRole('spinbutton', { name: 'Width', exact: true }).inputValue(), '11200');
    assert.equal(await paperStudio.getByRole('spinbutton', { name: 'Rotation (degrees)', exact: true }).inputValue(), '-8');
    await paperStudio.getByRole('button', { name: 'Place on Template' }).click();
    await paperStudio.getByRole('button', { name: 'Auto-Fit' }).click();
    await paperStudio.getByRole('button', { name: 'Save Layout' }).click();
    await paperStudio.waitFor({ state: 'detached' });

    const electronicRow = flightDialog.getByText('Electronic Boarding Pass', { exact: true }).locator('..');
    await electronicRow.getByRole('button', { name: 'Crop Boarding Pass' }).click();
    const electronicStudio = page.getByRole('dialog', { name: /Boarding Pass Layout: Electronic Boarding Pass/ }); await electronicStudio.waitFor();
    assert.equal(await electronicStudio.getByText(/Could not load the bound image/).count(), 0, 'electronic Studio rejected the large image');
    assert.equal(await electronicStudio.getByRole('spinbutton', { name: 'Center X', exact: true }).inputValue(), '7000');
    assert.equal(await electronicStudio.getByRole('spinbutton', { name: 'Center Y', exact: true }).inputValue(), '5000');
    assert.equal(await electronicStudio.getByRole('spinbutton', { name: 'Width', exact: true }).inputValue(), '4000');
    assert.equal(await electronicStudio.getByRole('spinbutton', { name: 'Height', exact: true }).inputValue(), '6000');
    await electronicStudio.getByRole('button', { name: /Next.*Colors/ }).click();
    await electronicStudio.getByRole('button', { name: 'Save Layout' }).click();
    await electronicStudio.waitFor({ state: 'detached' });

    const savedFlights = await page.evaluate(() => fetch('/api/archive/flightarchive/documents/flights.json').then((response) => response.json()));
    assert.deepEqual(savedFlights[0].paperBoardingPassLayouts.paperBoardingPassFront.crop, crop);
    assert.deepEqual(savedFlights[0].electronicBoardingPass.extraction.crop, electronicCrop);
    await flightDialog.getByRole('button', { name: 'Close' }).click(); await flightDialog.waitFor({ state: 'detached' });

    // The 4 MP RGBA derivative is intentionally over 4 MiB; Studio must retry
    // the next dyadic scale while retaining the 2000x2000 logical coordinates.
    const entropyRow = page.getByRole('row').filter({ hasText: 'CA101' });
    await entropyRow.getByRole('button', { name: 'Edit Flight' }).click();
    const entropyFlightDialog = page.getByRole('dialog', { name: 'Edit Flight' });
    await entropyFlightDialog.getByText('Paper Front', { exact: true }).locator('..').getByRole('button', { name: 'Crop Boarding Pass' }).click();
    const entropyStudio = page.getByRole('dialog', { name: /Boarding Pass Layout: Paper Front/ }); await entropyStudio.waitFor();
    assert.equal(await entropyStudio.getByText(/Could not load the bound image/).count(), 0, 'Studio did not retry the oversized encoded derivative');
    await entropyStudio.getByRole('button', { name: /Back.*Detect & Crop/ }).click();
    assert.equal(await entropyStudio.getByRole('spinbutton', { name: 'Center X', exact: true }).inputValue(), '1000');
    assert.equal(await entropyStudio.getByRole('spinbutton', { name: 'Rotation (degrees)', exact: true }).inputValue(), '11');
    const entropyStudioRequests = relayRequests.filter((requestUrl) => decodeURIComponent(new URL(requestUrl).pathname).endsWith(entropyPath)).map((requestUrl) => new URL(requestUrl).searchParams.get('scale'));
    assert(entropyStudioRequests.includes('1') && entropyStudioRequests.includes('0.5'), `Studio fallback scales ${entropyStudioRequests.join(',')}`);
    await entropyStudio.getByRole('button', { name: 'Cancel' }).click(); await entropyFlightDialog.getByRole('button', { name: 'Close' }).click();

    // Exercise Chromium's native no-cache revalidation without request interception.
    const probeUrl = `/api/thumbnails/${encodeURIComponent(cacheProbePath).replace(/%2F/g, '/')}?scale=1`;
    const browserCache = await page.evaluate(async (url) => {
      const read = async () => { const response = await fetch(url); return { status: response.status, etag: response.headers.get('etag'), width: response.headers.get('x-thumbnail-width'), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) }; };
      return [await read(), await read()];
    }, probeUrl);
    assert.equal(browserCache[0].status, 200); assert.equal(browserCache[1].status, 200);
    assert.equal(browserCache[0].etag, browserCache[1].etag); assert.deepEqual(browserCache[0].bytes, browserCache[1].bytes);
    await page.waitForTimeout(200);
    const probeWireIds = [...wireUrls].filter(([, url]) => url.endsWith(probeUrl)).map(([requestId]) => requestId);
    assert(probeWireIds.some((requestId) => conditionalRequestIds.has(requestId)), 'Chromium did not send If-None-Match');
    assert(probeWireIds.some((requestId) => notModifiedRequestIds.has(requestId)), 'wire response did not include 304');

    const reboundMappings = mappings.map((entry) => entry.virtual_path === cacheProbePath ? { ...entry, local_path: 'cache-second.png' } : entry);
    await page.evaluate((document) => fetch('/api/v1/meta/map', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: document }) }).then((response) => { if (!response.ok) throw new Error(`mapping rebind ${response.status}`); }), reboundMappings);
    const rebound = await page.evaluate(async (url) => { const response = await fetch(url); return { status: response.status, etag: response.headers.get('etag'), width: response.headers.get('x-thumbnail-width'), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) }; }, probeUrl);
    assert.equal(rebound.status, 200); assert.equal(rebound.width, '640'); assert.notEqual(rebound.etag, browserCache[0].etag); assert.notDeepEqual(rebound.bytes, browserCache[0].bytes);

    assert.equal(originals.length, 0, `ordinary browse fetched original resources: ${originals.join(', ')}`);
    assert(relay.every((item) => item.size === 0 || item.size <= 4 * 1024 * 1024), 'browser received an oversized relay payload');
    const unexpectedErrors = errors.filter((message) => !(message.includes('413') && message.includes('Content Too Large')));
    assert.equal(unexpectedErrors.length, 0, unexpectedErrors.join('\n'));
    browserMetrics = { initialRelayRequests: beforeScroll, relayRequestsAfterScroll: afterDown, originalResourceRequests: originals.length, conditionalValidators: conditionalRequestIds.size, wire304s: notModifiedRequestIds.size, expectedFallback413s: errors.length - unexpectedErrors.length, unexpectedConsoleOrPageErrors: unexpectedErrors.length };
  } finally { await page.close(); await browser.close(); }
  const cacheFiles = await readdir(cache);
  assert(cacheFiles.some((name) => name.endsWith('.webp')) && cacheFiles.some((name) => name.endsWith('.json')), 'relay cache files were not written');
  console.log(JSON.stringify({ source: { bytes: sourceBytes, dimensions: '14000x10000' }, jpeg: { thumbnail: `${cold.value.width}x${cold.value.height}`, encodedBytes: cold.value.bytes.byteLength, coldMs: Math.round(cold.milliseconds), warmMs: Math.round(hot.milliseconds) }, png: { dimensions: '7000x5000', coldMs: Math.round(pngCold.milliseconds), warmMs: Math.round(pngHot.milliseconds) }, browser: browserMetrics, cacheFiles: cacheFiles.length, result: 'passed' }, null, 2));
} finally {
  if (server?.exitCode === null) { server.kill('SIGTERM'); await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]); }
  await rm(root, { recursive: true, force: true });
}
