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
import { access, appendFile, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
const relayEvents = path.join(root, 'relay-events.log');
const serverWrapper = path.join(root, 'instrumented_server.py');
const staticDir = path.join(frontend, 'build');
const port = 43000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const sourcePath = 'nested/航 班/100%#scan.jpg';
const pngPath = 'nested/PNG scan.png';
let server;
let browserMetrics;
let focusedPriorityStarts = [];
let sharedDisplayScale = null;

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
Image.new('RGB', (480, 270), '#27804a').save(r / 'crud-source.png', 'PNG')
channels = [Image.effect_noise((2000, 2000), 100).convert('L') for _ in range(4)]
entropy = Image.merge('RGBA', tuple(channels)); entropy.save(r / 'entropy-alpha.png', 'PNG', optimize=False)
entropy.close()
for channel in channels: channel.close()
os.link(target, r / 'logo-source.jpg')
for i in range(92): os.link(target, r / f'copy-{i}.jpg')
`;

try {
  const generated = run(python, ['-c', generator, root]);
  await once(generated, 'exit');
  if (generated.exitCode !== 0) throw new Error(`fixture generator failed\n${generated.output()}`);
  await writeFile(serverWrapper, String.raw`
import os, threading, time
from flightarchive.thumbnail import ThumbnailService
events = os.environ['FLIGHTARCHIVE_TEST_RELAY_EVENTS']
lock = threading.Lock(); original_render = ThumbnailService._render; original_source_get = ThumbnailService._source_get
def record(message):
    with lock:
        with open(events, 'a', encoding='utf-8') as stream: stream.write(message + '\n'); stream.flush()
async def observed_source_get(self, virtual_path, source):
    record('source-start:' + virtual_path)
    try: return await original_source_get(self, virtual_path, source)
    finally: record('source-end:' + virtual_path)
def delayed_render(payload, geometry):
    record('render-start'); time.sleep(0.20)
    try: return original_render(payload, geometry)
    finally: record('render-end')
ThumbnailService._source_get = observed_source_get
ThumbnailService._render = staticmethod(delayed_render)
from flightarchive.__main__ import main
raise SystemExit(main())
`, 'utf8');
  await writeFile(relayEvents, '', 'utf8');
  server = run(python, [serverWrapper, '--host', '127.0.0.1', '--port', String(port), '--resource-root', resources, '--data-root', runtime, '--static-dir', staticDir], {
    cwd: backend,
    env: { ...process.env, PYTHONPATH: [backend, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), RFG_RESOURCE_PATH: resources, RFG_DATA_DIR: runtime, FLIGHTARCHIVE_CACHE_DIR: cache, FLIGHTARCHIVE_STATIC_DIR: staticDir, FLIGHTARCHIVE_TEST_RELAY_EVENTS: relayEvents },
  });
  await waitFor(`${origin}/api/healthz`, server);

  const cacheProbePath = 'cache/probe.png';
  const entropyPath = 'studio/entropy-alpha.png'; const logoPath = 'logos/slow.png'; const crudPath = 'crud/source.png';
  const mappings = [{ virtual_path: sourcePath, local_path: 'large-source.jpg' }, { virtual_path: pngPath, local_path: 'large-source.png' }, { virtual_path: cacheProbePath, local_path: 'cache-first.png' }, { virtual_path: entropyPath, local_path: 'entropy-alpha.png' }, { virtual_path: logoPath, local_path: 'logo-source.jpg' }];
  for (let index = 0; index < 92; index += 1) mappings.push({ virtual_path: `scan/${index}.jpg`, local_path: `copy-${index}.jpg` });
  await request('/api/v1/meta/map', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: mappings }) });
  const map = await request('/api/v1/meta/map'); assert.equal((await map.json()).entries.length, mappings.length);

  const now = '2026-01-01T00:00:00.000Z';
  const crop = { centerX: 7000, centerY: 5000, width: 11200, height: 4200, rotationDegrees: -8 };
  const backCrop = { centerX: 3500, centerY: 2500, width: 5600, height: 2100, rotationDegrees: -8 };
  const sharedBackCrop = { centerX: 7000, centerY: 5000, width: 10000, height: 3600, rotationDegrees: 6 };
  const layout = { schemaVersion: 1, algorithm: 'adaptive', crop, templateId: 'bp-247.svg', placement: { scale: 1, rotationDegrees: 7, offsetX: 0.04, offsetY: -0.03 } };
  const backLayout = { ...layout, crop: backCrop };
  const sharedBackLayout = { ...layout, crop: sharedBackCrop };
  const entropyCrop = { centerX: 1000, centerY: 1000, width: 1500, height: 700, rotationDegrees: 11 };
  const entropyLayout = { ...layout, crop: entropyCrop };
  const electronicCrop = { centerX: 7000, centerY: 5000, width: 4000, height: 6000, mirrorAcrossImageCenterX: false };
  const flights = Array.from({ length: 92 }, (_, index) => ({
    id: `fixture-${index}`, flightNumber: String(100 + index), airlineCode: 'CA', departureAirport: 'PEK', arrivalAirport: 'PVG', departureTerminal: null, arrivalTerminal: null,
    departureDate: '2026-01-01', departureTime: '12:00', arrivalTime: null, aircraftTypeIcao: 'A320', registration: null, seat: '1A', notes: '', createdAt: now, updatedAt: now,
    paperBoardingPassFrontResourcePath: index === 0 ? sourcePath : index === 1 ? entropyPath : `scan/${index}.jpg`, paperBoardingPassBackResourcePath: index === 0 ? sourcePath : pngPath, electronicBoardingPassResourcePath: index === 0 ? sourcePath : null,
    attachmentResourcePaths: index === 0 ? [sourcePath] : [], paperBoardingPassLayouts: { paperBoardingPassFront: index === 1 ? entropyLayout : layout, paperBoardingPassBack: index === 0 ? sharedBackLayout : backLayout }, electronicBoardingPass: index === 0 ? { schemaVersion: 1, extraction: { crop: electronicCrop, presetName: 'Large fixture' } } : null, boardingPassColor: index === 0 ? '#123456' : null,
  }));
  await request('/api/archive/flightarchive/documents/flights.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(flights) });
  await request('/api/archive/flightarchive/documents/airlines.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ code: 'CA', icao: 'CCA', nameZh: '中国国航', nameEn: 'Air China', alliance: null, horizontalLogoResourcePath: logoPath, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: logoPath, brandColors: { primary: null, contrast: null } }]) });
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
  const mappingWrites = []; const archiveWrites = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); }); page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/thumbnails/')) relayRequests.push(request.url()); });
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/v1/meta/map' && request.method() === 'PUT') mappingWrites.push(request.url()); });
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/archive/flightarchive/documents/') && request.method() === 'PUT') archiveWrites.push(request.url()); });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/thumbnails/')) relay.push({ url: response.url(), size: Number(response.headers()['content-length'] ?? 0) });
    if (url.pathname.startsWith('/res/')) originals.push(response.url());
  });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('button[aria-label="Card Grid View"], button[aria-label="卡片网格视图"]').click();
    const focusedColdCard = page.locator('[role="button"]').filter({ hasText: 'CA102' }).first();
    await focusedColdCard.waitFor();
    // Confirm the old grid pipeline actually entered and completed one source
    // before placing the marker. This prevents a pre-marker source-start event
    // from racing across the file append boundary and makes the priority
    // assertion deterministic without weakening it.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readFile(relayEvents, 'utf8')).includes('source-end:scan/91.jpg')) break;
      if (attempt === 99) throw new Error('old grid resource never entered the relay pipeline');
      await page.waitForTimeout(50);
    }
    await appendFile(relayEvents, 'MARK:detail-switch\n', 'utf8');
    await focusedColdCard.click();
    const focusedDialog = page.getByRole('dialog'); await focusedDialog.waitFor();
    const focusedImage = focusedDialog.locator('img[alt="Paper Front"], img[alt="纸质正面"]').first();
    await focusedImage.waitFor(); await focusedImage.evaluate((image) => image.decode());
    const afterSwitchEvents = (await readFile(relayEvents, 'utf8')).split('MARK:detail-switch\n').at(-1).trim().split('\n').filter(Boolean);
    const priorityStarts = afterSwitchEvents.filter((event) => event.startsWith('source-start:scan/'));
    focusedPriorityStarts = priorityStarts;
    assert.equal(priorityStarts[0], 'source-start:scan/2.jpg', `focused detail did not lead old queued scans: ${priorityStarts.join(',')}`);
    assert(priorityStarts.every((event) => event === 'source-start:scan/2.jpg'), `inactive old surface reached full source GET: ${priorityStarts.join(',')}`);
    await focusedDialog.getByRole('button', { name: /Close Details|关闭详情/ }).click(); await focusedDialog.waitFor({ state: 'hidden' });
    await page.locator('[role="progressbar"]:visible').first().waitFor({ timeout: 3000 });
    const logoHost = page.getByRole('img', { name: 'Air China' }).first(); await logoHost.waitFor();
    const logoLoading = logoHost.getByTestId('image-loading-indicator-host'); await logoLoading.waitFor();
    const [hostBox, loaderBox] = await Promise.all([logoHost.boundingBox(), logoLoading.boundingBox()]);
    assert(hostBox && loaderBox && loaderBox.x >= hostBox.x && loaderBox.y >= hostBox.y && loaderBox.x + loaderBox.width <= hostBox.x + hostBox.width && loaderBox.y + loaderBox.height <= hostBox.y + hostBox.height, 'airline logo spinner escaped its host bounds');
    await page.waitForTimeout(1500);
    const firstPreview = await page.locator('img[alt="Paper Front"], img[alt="纸质正面"]').first().evaluate((image) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, src: image.src }));
    assert(firstPreview.complete && firstPreview.width > 0 && firstPreview.height > 0, 'first preview did not decode');
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('[role="progressbar"]')).some((element) => { const style = getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden' && element.getBoundingClientRect().width > 0; }));
    assert.equal(await logoLoading.getByRole('progressbar').count(), 0, 'airline logo spinner remained after image load');
    assert.equal(await page.getByText(/preview unavailable/i).count(), 0, 'preview fallback displayed');
    const beforeScroll = relayRequests.length; assert(beforeScroll > 0 && beforeScroll < 184, `viewport relay count ${beforeScroll}`);
    await page.locator('[role="button"]').filter({ hasText: 'CA191' }).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500); assert(relayRequests.length > beforeScroll, 'scroll did not request deferred previews');
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

    // First visit to list does its own work, but both visited surfaces retain
    // their DOM/object URLs on subsequent switches. The compact list loader is
    // bounded by the 58 x ~23 px preview rather than using a fixed large ring.
    await page.getByRole('button', { name: /List View|列表视图/ }).click();
    const uniqueRow = page.locator('[role="button"]').filter({ hasText: 'CA0100' }).first();
    await uniqueRow.scrollIntoViewIfNeeded();
    const listPreviewHost = uniqueRow.getByTestId('flight-list-paper-front-preview');
    const listLoaderHost = listPreviewHost.getByTestId('image-loading-indicator-host');
    const [listHostBox, listLoaderBox] = await Promise.all([listPreviewHost.boundingBox(), listLoaderHost.boundingBox()]);
    assert(listHostBox && listLoaderBox && listLoaderBox.width <= listHostBox.width && listLoaderBox.height <= listHostBox.height, 'list loader overlay escaped the compact preview');
    const listImage = listPreviewHost.locator('img[alt="Paper Front"], img[alt="纸质正面"]').first();
    await listImage.waitFor(); await listImage.evaluate((image) => image.decode());
    const listSrc = await listImage.getAttribute('src');
    const loadedUniqueRequests = relayRequests.filter((requestUrl) => decodeURIComponent(new URL(requestUrl).pathname).endsWith(sourcePath)).length;
    await page.getByRole('button', { name: /Card Grid View|卡片网格视图/ }).click();
    await uniqueCard.scrollIntoViewIfNeeded();
    assert.equal(await uniqueImage.getAttribute('src'), uniqueSrc, 'grid return replaced its retained blob URL');
    await page.getByRole('button', { name: /List View|列表视图/ }).click();
    await uniqueRow.scrollIntoViewIfNeeded();
    assert.equal(await listImage.getAttribute('src'), listSrc, 'list return replaced its retained blob URL');
    assert.equal(relayRequests.filter((requestUrl) => decodeURIComponent(new URL(requestUrl).pathname).endsWith(sourcePath)).length, loadedUniqueRequests, 'returning re-requested an already-ready source');

    await uniqueRow.click();
    const detailDialog = page.getByRole('dialog'); await detailDialog.waitFor();
    const detailImage = detailDialog.locator('img[alt="Paper Front"], img[alt="纸质正面"]').first();
    await detailImage.waitFor(); await detailImage.evaluate((image) => image.decode());
    const attachmentRow = detailDialog.locator('li').filter({ hasText: '100%#scan.jpg' });
    await attachmentRow.scrollIntoViewIfNeeded();
    const attachmentImage = attachmentRow.locator('img[alt="100%#scan.jpg"]');
    await attachmentImage.waitFor(); await attachmentImage.evaluate((image) => image.decode());
    const detailSrc = await detailImage.getAttribute('src');
    await detailDialog.getByRole('button', { name: /Close Details|关闭详情/ }).click(); await detailDialog.waitFor({ state: 'hidden' });
    const afterDetailClose = relayRequests.length;
    await uniqueRow.click(); await detailDialog.waitFor({ state: 'visible' });
    assert.equal(await detailImage.getAttribute('src'), detailSrc, 'detail reopen replaced its retained blob URL');
    assert.equal(relayRequests.length, afterDetailClose, 'detail reopen issued another relay request');
    const sourceDisplayScales = new Set(relayRequests
      .filter((requestUrl) => decodeURIComponent(new URL(requestUrl).pathname).endsWith(sourcePath))
      .map((requestUrl) => new URL(requestUrl).searchParams.get('scale'))
      .filter((scale) => scale && scale !== '0.015625'));
    assert.equal(sourceDisplayScales.size, 1, `front/back/file-row consumers selected different relay scales: ${[...sourceDisplayScales].join(', ')}`);
    assert.deepEqual([...sourceDisplayScales], ['0.0625']);
    sharedDisplayScale = [...sourceDisplayScales][0];
    await detailDialog.getByRole('button', { name: /Close Details|关闭详情/ }).click(); await detailDialog.waitFor({ state: 'hidden' });

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

    // Exercise a real frontend → archive + RFG first-bind/delete round trip
    // against the generated /tmp runtime. Assertions follow the path persisted
    // by the frontend rather than assuming the pre-CRUD virtual path survives.
    await page.getByRole('button', { name: 'Add Flight' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Add Flight' }); await createDialog.waitFor();
    await createDialog.getByRole('combobox', { name: 'Airline' }).fill('CA');
    await createDialog.getByRole('textbox', { name: 'Flight Number' }).fill('777');
    await createDialog.locator('input[type="date"]').fill('2026-12-31');
    await createDialog.getByRole('combobox', { name: 'Origin Airport' }).fill('PEK');
    await createDialog.getByRole('combobox', { name: 'Destination Airport' }).fill('PVG');
    const createPaperRow = createDialog.getByText('Paper Front', { exact: true }).locator('..');
    await createPaperRow.getByRole('button', { name: 'Select Resource' }).click();
    const picker = page.getByRole('dialog', { name: 'Paper Front' }); await picker.waitFor();
    await picker.getByRole('textbox', { name: 'Search Resources' }).fill('crud-source.png');
    await picker.getByRole('button', { name: /inbox\/crud-source\.png/ }).click();
    await picker.getByRole('button', { name: 'Select Resource' }).click();
    const draftMappingWrites = mappingWrites.length; const draftArchiveWrites = archiveWrites.length;
    assert.equal((await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()))).entries.find((entry) => entry.local_path === 'crud-source.png').virtual_path, 'inbox/crud-source.png');
    await createDialog.getByRole('button', { name: 'Close' }).click(); await createDialog.waitFor({ state: 'detached' });
    assert.equal(mappingWrites.length, draftMappingWrites, 'closing an inbox draft mutated its mapping');
    assert.equal(archiveWrites.length, draftArchiveWrites, 'closing an inbox draft wrote the archive');

    await page.getByRole('button', { name: 'Add Flight' }).click(); await createDialog.waitFor();
    await createDialog.getByRole('combobox', { name: 'Airline' }).fill('CA');
    await createDialog.getByRole('textbox', { name: 'Flight Number' }).fill('777');
    await createDialog.locator('input[type="date"]').fill('2026-12-31');
    await createDialog.getByRole('combobox', { name: 'Origin Airport' }).fill('PEK');
    await createDialog.getByRole('combobox', { name: 'Destination Airport' }).fill('PVG');
    await createDialog.getByText('Paper Front', { exact: true }).locator('..').getByRole('button', { name: 'Select Resource' }).click();
    await picker.waitFor(); await picker.getByRole('textbox', { name: 'Search Resources' }).fill('crud-source.png');
    await picker.getByRole('button', { name: /inbox\/crud-source\.png/ }).click(); await picker.getByRole('button', { name: 'Select Resource' }).click();
    await createDialog.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Flight added.').waitFor();
    const createdFlights = await page.evaluate(() => fetch('/api/archive/flightarchive/documents/flights.json').then((response) => response.json()));
    const createdFlight = createdFlights.find((flight) => flight.flightNumber === '777');
    assert(createdFlight, 'CRUD flight was not persisted');
    assert.equal(createdFlight.paperBoardingPassFrontResourcePath, '20261231ca0777a0.png');
    const createdMapping = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    assert.equal(createdMapping.entries.find((entry) => entry.local_path === 'crud-source.png').virtual_path, createdFlight.paperBoardingPassFrontResourcePath);
    const createdEditDialog = page.getByRole('dialog', { name: 'Edit Flight' }); await createdEditDialog.waitFor();
    await createdEditDialog.getByRole('button', { name: 'Close' }).click(); await createdEditDialog.waitFor({ state: 'detached' });
    const createdRow = page.getByRole('row').filter({ hasText: 'CA777' });
    await createdRow.getByRole('button', { name: 'Delete Flight' }).click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete Flight' });
    await deleteDialog.getByRole('button', { name: 'Delete' }).click(); await deleteDialog.waitFor({ state: 'detached' });
    const releasedMapping = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    assert.equal(releasedMapping.entries.find((entry) => entry.local_path === 'crud-source.png').virtual_path, 'inbox/crud-source.png');
    const afterDeleteFlights = await page.evaluate(() => fetch('/api/archive/flightarchive/documents/flights.json').then((response) => response.json()));
    assert(!afterDeleteFlights.some((flight) => flight.id === createdFlight.id), 'CRUD flight remained after mapping release and deletion');

    // Full live source lifecycle through the real RFG catalog and mappings UI.
    const lifecycleLocal = 'lifecycle-source.png';
    const lifecycleFile = path.join(resources, lifecycleLocal);
    await copyFile(path.join(resources, 'cache-first.png'), lifecycleFile);
    await page.getByRole('navigation').getByRole('button').nth(2).click();
    await page.getByRole('heading', { name: 'Resource Mappings' }).waitFor();
    const refreshMappings = async () => {
      await page.getByRole('button', { name: 'Refresh Resources' }).click();
      await page.waitForFunction(() => !document.querySelector('button[disabled]')?.textContent?.includes('Refresh Resources'));
    };
    await refreshMappings();
    let lifecycleMapping = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    assert.equal(lifecycleMapping.entries.find((entry) => entry.local_path === lifecycleLocal).virtual_path, `inbox/${lifecycleLocal}`);

    await page.getByRole('tab', { name: /Pending \(/ }).click();
    let lifecycleRow = page.getByRole('row').filter({ hasText: `inbox/${lifecycleLocal}` });
    await lifecycleRow.getByRole('button', { name: 'Ignore Resource' }).click();
    await page.waitForFunction((localPath) => fetch('/api/v1/meta/map').then((response) => response.json()).then((mapping) => mapping.entries.some((entry) => entry.local_path === localPath && entry.virtual_path === `ignore/${localPath}`)), lifecycleLocal);
    await rm(lifecycleFile);
    await refreshMappings();
    lifecycleMapping = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    assert.equal(lifecycleMapping.entries.some((entry) => entry.local_path === lifecycleLocal), false, 'absent disposable ignore entry was not removed');

    await copyFile(path.join(resources, 'cache-first.png'), lifecycleFile);
    await refreshMappings();
    lifecycleMapping = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    assert.equal(lifecycleMapping.entries.find((entry) => entry.local_path === lifecycleLocal).virtual_path, `inbox/${lifecycleLocal}`, 'returning ignored source was not rediscovered in inbox');
    const createLifecycleFlight = async (number, searchPath) => {
      await page.getByRole('button', { name: 'Add Flight' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add Flight' }); await dialog.waitFor();
      await dialog.getByRole('combobox', { name: 'Airline' }).fill('CA');
      await dialog.getByRole('textbox', { name: 'Flight Number' }).fill(number);
      await dialog.locator('input[type="date"]').fill('2027-01-02');
      await dialog.getByRole('combobox', { name: 'Origin Airport' }).fill('PEK');
      await dialog.getByRole('combobox', { name: 'Destination Airport' }).fill('PVG');
      await dialog.getByText('Paper Front', { exact: true }).locator('..').getByRole('button', { name: 'Select Resource' }).click();
      const pickerDialog = page.getByRole('dialog', { name: 'Paper Front' }); await pickerDialog.waitFor();
      await pickerDialog.getByRole('textbox', { name: 'Search Resources' }).fill(searchPath);
      await pickerDialog.getByRole('button', { name: new RegExp(searchPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
      await pickerDialog.getByRole('button', { name: 'Select Resource' }).click();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await page.getByText('Flight added.').waitFor();
      const allFlights = await page.evaluate(() => fetch('/api/archive/flightarchive/documents/flights.json').then((response) => response.json()));
      const created = allFlights.find((flight) => flight.flightNumber === number);
      const editDialog = page.getByRole('dialog', { name: 'Edit Flight' }); await editDialog.getByRole('button', { name: 'Close' }).click(); await editDialog.waitFor({ state: 'detached' });
      return created;
    };
    const deleteFlightByNumber = async (number) => {
      const row = page.getByRole('row').filter({ hasText: `CA${number}` });
      await row.getByRole('button', { name: 'Delete Flight' }).click();
      const confirmation = page.getByRole('dialog', { name: 'Delete Flight' });
      await confirmation.getByRole('button', { name: 'Delete' }).click(); await confirmation.waitFor({ state: 'detached' });
    };

    await page.getByRole('navigation').getByRole('button').nth(1).click();
    const firstLifecycleFlight = await createLifecycleFlight('778', `inbox/${lifecycleLocal}`);
    const managedLifecyclePath = firstLifecycleFlight.paperBoardingPassFrontResourcePath;
    const secondLifecycleFlight = await createLifecycleFlight('779', managedLifecyclePath);
    assert.equal(secondLifecycleFlight.paperBoardingPassFrontResourcePath, managedLifecyclePath, 'shared flight did not retain the existing mapping');

    // Manual release is guarded by latest business references and sends no RFG PUT.
    await page.getByRole('navigation').getByRole('button').nth(2).click();
    await page.getByRole('tab', { name: /Mapped \(/ }).click();
    lifecycleRow = page.getByRole('row').filter({ hasText: lifecycleLocal });
    const writesBeforeBlockedRelease = mappingWrites.length;
    await lifecycleRow.getByRole('button', { name: 'Release Mapping' }).click();
    const blockedRelease = page.getByRole('dialog', { name: 'Release Resource Mappings?' });
    await blockedRelease.getByRole('button', { name: 'Release Mapping' }).click();
    await page.getByText(/still used by a flight or airline/i).waitFor();
    assert.equal(mappingWrites.length, writesBeforeBlockedRelease, 'referenced manual release sent an RFG mapping PUT');
    assert.equal(await page.locator('main [role="alert"]').count(), 0, 'release guard duplicated feedback as a page-top alert');
    await page.getByRole('button', { name: 'Activity & Tasks' }).click();
    const feedbackHeading = page.getByRole('heading', { name: 'Activity & Tasks' }); await feedbackHeading.waitFor();
    const guardRecords = page.getByTestId('activity-record').filter({ hasText: /still used by a flight or airline/i });
    assert.equal(await guardRecords.count(), 1, 'release guard did not create exactly one static session record');
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await feedbackHeading.waitFor({ state: 'detached' });

    await page.getByRole('navigation').getByRole('button').nth(1).click();
    await deleteFlightByNumber('778');
    let sharedMapping = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    const handedOff = sharedMapping.entries.find((entry) => entry.local_path === lifecycleLocal);
    assert.equal(handedOff.virtual_path, '20270102ca0779a0.png', 'primary deletion did not hand the alias to the remaining owner');
    await deleteFlightByNumber('779');
    sharedMapping = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    assert.equal(sharedMapping.entries.find((entry) => entry.local_path === lifecycleLocal).virtual_path, `inbox/${lifecycleLocal}`);

    // Missing release removes the virtual mapping; rediscovery recreates inbox.
    await page.getByRole('navigation').getByRole('button').nth(2).click();
    const missingFixture = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    const missingEntry = missingFixture.entries.find((entry) => entry.local_path === lifecycleLocal); missingEntry.virtual_path = 'objects/missing-cycle.png';
    await page.evaluate((mapping) => fetch('/api/v1/meta/map', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mapping) }).then((response) => { if (!response.ok) throw new Error(`missing fixture ${response.status}`); }), missingFixture);
    await rm(lifecycleFile); await refreshMappings();
    await page.getByRole('tab', { name: /Missing Source \(/ }).click();
    lifecycleRow = page.getByRole('row').filter({ hasText: 'objects/missing-cycle.png' });
    await lifecycleRow.getByRole('button', { name: 'Release Mapping' }).click();
    const missingRelease = page.getByRole('dialog', { name: 'Release Resource Mappings?' });
    await missingRelease.getByRole('button', { name: 'Release Mapping' }).click(); await missingRelease.waitFor({ state: 'detached' });
    assert(!(await page.evaluate((localPath) => fetch('/api/v1/meta/map').then((response) => response.json()).then((mapping) => mapping.entries.some((entry) => entry.local_path === localPath)), lifecycleLocal)), 'missing release retained its mapping');
    await copyFile(path.join(resources, 'cache-first.png'), lifecycleFile); await refreshMappings();
    assert.equal((await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()))).entries.find((entry) => entry.local_path === lifecycleLocal).virtual_path, `inbox/${lifecycleLocal}`);

    // A missing stable target consumes one present inbox candidate on rematch.
    const beforeRematch = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    beforeRematch.entries.push({ virtual_path: 'objects/rematch-target.png', local_path: 'gone-rematch.png', size_bytes: 123, sha256: 'remembered' });
    await page.evaluate((mapping) => fetch('/api/v1/meta/map', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mapping) }).then((response) => { if (!response.ok) throw new Error(`rematch fixture ${response.status}`); }), beforeRematch);
    await refreshMappings(); await page.getByRole('tab', { name: /Missing Source \(/ }).click();
    const rematchRow = page.getByRole('row').filter({ hasText: 'objects/rematch-target.png' });
    await rematchRow.getByRole('button', { name: 'Manual rematch…' }).click();
    const rematchPicker = page.getByRole('dialog', { name: 'Manual rematch' });
    await rematchPicker.getByRole('textbox', { name: 'Search Resources' }).fill(lifecycleLocal);
    await rematchPicker.getByRole('button', { name: new RegExp(`inbox/${lifecycleLocal}`) }).click();
    await rematchPicker.getByRole('button', { name: 'Select Resource' }).click(); await rematchPicker.waitFor({ state: 'detached' });
    const afterRematch = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    assert.equal(afterRematch.entries.find((entry) => entry.virtual_path === 'objects/rematch-target.png').local_path, lifecycleLocal);
    assert.equal(afterRematch.entries.filter((entry) => entry.local_path === lifecycleLocal).length, 1, 'rematch left a duplicate local mapping');
    assert.equal(new Set(afterRematch.entries.map((entry) => entry.virtual_path)).size, afterRematch.entries.length, 'rematch left a duplicate virtual mapping');

    const presentOldLocal = 'present-old.png'; const presentCandidateLocal = 'present-candidate.png';
    await copyFile(path.join(resources, 'cache-first.png'), path.join(resources, presentOldLocal));
    await copyFile(path.join(resources, 'cache-second.png'), path.join(resources, presentCandidateLocal));
    const presentRematchFixture = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    presentRematchFixture.entries.push({ virtual_path: 'objects/present-rematch.png', local_path: presentOldLocal, size_bytes: (await stat(path.join(resources, presentOldLocal))).size, sha256: 'old-hash' });
    await page.evaluate((mapping) => fetch('/api/v1/meta/map', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mapping) }).then((response) => { if (!response.ok) throw new Error(`present rematch fixture ${response.status}`); }), presentRematchFixture);
    await refreshMappings(); await page.getByRole('tab', { name: /Mapped \(/ }).click();
    const presentRematchRow = page.getByRole('row').filter({ hasText: 'objects/present-rematch.png' });
    await presentRematchRow.getByRole('button', { name: 'Manual rematch…' }).click();
    const presentRematchPicker = page.getByRole('dialog', { name: 'Manual rematch' });
    await presentRematchPicker.getByRole('textbox', { name: 'Search Resources' }).fill(presentCandidateLocal);
    await presentRematchPicker.getByRole('button', { name: new RegExp(`inbox/${presentCandidateLocal}`) }).click();
    await presentRematchPicker.getByRole('button', { name: 'Select Resource' }).click(); await presentRematchPicker.waitFor({ state: 'detached' });
    const presentRematched = await page.evaluate(() => fetch('/api/v1/meta/map').then((response) => response.json()));
    assert.equal(presentRematched.entries.find((entry) => entry.virtual_path === 'objects/present-rematch.png').local_path, presentCandidateLocal);
    assert.equal(presentRematched.entries.find((entry) => entry.local_path === presentOldLocal).virtual_path, `inbox/${presentOldLocal}`, 'present rematch did not return the prior source to inbox immediately');
    assert.equal(presentRematched.entries.filter((entry) => entry.local_path === presentCandidateLocal).length, 1, 'present rematch retained its candidate entry');

    // Real browser archive-failure window: inject an unrelated discovery and
    // hash update after the coordinated mapping transition, before returning
    // the archive failure. Scoped compensation must preserve both.
    const scopeLocal = 'scope-source.png'; const scopeDiscoveredLocal = 'scope-discovered.png'; const transitionDiscoveredLocal = 'transition-discovered.png';
    await copyFile(path.join(resources, 'cache-second.png'), path.join(resources, scopeLocal));
    await refreshMappings();
    await page.getByRole('navigation').getByRole('button').nth(1).click();
    const scopeFlight = await createLifecycleFlight('780', `inbox/${scopeLocal}`);
    const scopeManagedPath = scopeFlight.paperBoardingPassFrontResourcePath;
    await copyFile(path.join(resources, 'cache-first.png'), path.join(resources, transitionDiscoveredLocal));
    let injectedArchiveFailure = false;
    const flightsDocumentUrl = '**/api/archive/flightarchive/documents/flights.json';
    await page.route(flightsDocumentUrl, async (route) => {
      if (route.request().method() !== 'PUT' || injectedArchiveFailure) return route.continue();
      injectedArchiveFailure = true;
      const transitioned = await request('/api/v1/meta/map').then((response) => response.json());
      assert.equal(transitioned.entries.find((entry) => entry.local_path === scopeLocal).virtual_path, `inbox/${scopeLocal}`, 'archive request began before mapping transition confirmation');
      assert.equal(transitioned.entries.find((entry) => entry.local_path === transitionDiscoveredLocal).virtual_path, `inbox/${transitionDiscoveredLocal}`, 'coordinated transition did not register its catalog discovery');
      await copyFile(path.join(resources, 'cache-first.png'), path.join(resources, scopeDiscoveredLocal));
      const augmented = { entries: transitioned.entries.map((entry) => entry.virtual_path === cacheProbePath ? { ...entry, sha256: 'scope-later-hash' } : entry) };
      augmented.entries.push({ virtual_path: `inbox/${scopeDiscoveredLocal}`, local_path: scopeDiscoveredLocal, size_bytes: (await stat(path.join(resources, scopeDiscoveredLocal))).size });
      await request('/api/v1/meta/map', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(augmented) });
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'synthetic-archive-failure' } }) });
    });
    const scopeRow = page.getByRole('row').filter({ hasText: 'CA780' });
    await scopeRow.getByRole('button', { name: 'Delete Flight' }).click();
    const scopeDeleteDialog = page.getByRole('dialog', { name: 'Delete Flight' });
    await scopeDeleteDialog.getByRole('button', { name: 'Delete' }).click();
    await page.getByText(/Operation Failed/i).waitFor();
    assert.equal(await page.locator('main [role="alert"]').count(), 0, 'archive failure duplicated feedback as a page-top alert');
    await scopeDeleteDialog.getByRole('button', { name: 'Cancel' }).click(); await scopeDeleteDialog.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Activity & Tasks' }).click(); await page.getByRole('heading', { name: 'Activity & Tasks' }).waitFor();
    assert.equal(await page.getByTestId('activity-record').filter({ hasText: /Operation Failed/i }).count(), 1, 'archive failure did not create exactly one static session record');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.unroute(flightsDocumentUrl);
    assert(injectedArchiveFailure, 'archive failure window was not exercised');
    const compensated = await request('/api/v1/meta/map').then((response) => response.json());
    assert.equal(compensated.entries.find((entry) => entry.local_path === scopeLocal).virtual_path, scopeManagedPath, 'scoped compensation did not restore the affected alias');
    assert.equal(compensated.entries.find((entry) => entry.local_path === scopeDiscoveredLocal).virtual_path, `inbox/${scopeDiscoveredLocal}`, 'scoped compensation lost a new discovery');
    assert.equal(compensated.entries.find((entry) => entry.local_path === transitionDiscoveredLocal).virtual_path, `inbox/${transitionDiscoveredLocal}`, 'scoped compensation reversed transition-time discovery');
    assert.equal(compensated.entries.find((entry) => entry.virtual_path === cacheProbePath).sha256, 'scope-later-hash', 'scoped compensation lost an unrelated hash update');
    const afterFailedScopeDelete = await request('/api/archive/flightarchive/documents/flights.json').then((response) => response.json());
    assert(afterFailedScopeDelete.some((flight) => flight.id === scopeFlight.id), 'archive-failed record was deleted');

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
    // The lifecycle section deliberately removes one synthetic source while a
    // previously requested preview may still be in flight. Chromium reports
    // that expected relay miss as a generic console 404 without its URL.
    const expectedLifecycle404s = errors.filter((message) => message === 'Failed to load resource: the server responded with a status of 404 (Not Found)');
    assert(expectedLifecycle404s.length <= 1, `unexpected lifecycle 404 count ${expectedLifecycle404s.length}`);
    const expectedArchive500s = errors.filter((message) => message === 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)');
    assert.equal(expectedArchive500s.length, 1, 'synthetic archive failure did not produce exactly one browser 500');
    const unexpectedErrors = errors.filter((message) => !(message.includes('413') && message.includes('Content Too Large')) && !expectedLifecycle404s.includes(message) && !expectedArchive500s.includes(message));
    assert.equal(unexpectedErrors.length, 0, unexpectedErrors.join('\n'));
    assert(!/Traceback|Exception in ASGI application/.test(server.output()), `server logged an unhandled disconnect failure:\n${server.output()}`);
    browserMetrics = { initialRelayRequests: beforeScroll, relayRequestsAfterScroll: afterDown, focusedColdSourceStarts: focusedPriorityStarts, sharedFrontBackFileScale: sharedDisplayScale, originalResourceRequests: originals.length, conditionalValidators: conditionalRequestIds.size, wire304s: notModifiedRequestIds.size, expectedFallback413s: errors.length - unexpectedErrors.length, unexpectedConsoleOrPageErrors: unexpectedErrors.length };
  } finally { await page.close(); await browser.close(); }
  const cacheFiles = await readdir(cache);
  assert(cacheFiles.some((name) => name.endsWith('.webp')) && cacheFiles.some((name) => name.endsWith('.json')), 'relay cache files were not written');
  console.log(JSON.stringify({ source: { bytes: sourceBytes, dimensions: '14000x10000' }, jpeg: { thumbnail: `${cold.value.width}x${cold.value.height}`, encodedBytes: cold.value.bytes.byteLength, coldMs: Math.round(cold.milliseconds), warmMs: Math.round(hot.milliseconds) }, png: { dimensions: '7000x5000', coldMs: Math.round(pngCold.milliseconds), warmMs: Math.round(pngHot.milliseconds) }, browser: browserMetrics, cacheFiles: cacheFiles.length, result: 'passed' }, null, 2));
} finally {
  if (server?.exitCode === null) { server.kill('SIGTERM'); await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]); }
  await rm(root, { recursive: true, force: true });
}
