// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Manual screenshot utility for development.
 *
 * Launches a headed Chromium browser, navigates to the given URL,
 * and saves a full-page screenshot.  Intended as a visual-feedback
 * tool during development — not an automated test.
 *
 * Usage:
 *   node scripts/screenshot.mjs                          # http://localhost:5173  →  temp/screenshot.png
 *   node scripts/screenshot.mjs --url http://localhost:5173 --out temp/demo.png
 *   node scripts/screenshot.mjs --wait 3000              # wait 3 s before capture
 *   node scripts/screenshot.mjs --selector '#flight-dialog-title'  # screenshot a specific element
 *   node scripts/screenshot.mjs --headed                 # show the browser window (default)
 *   node scripts/screenshot.mjs --headless               # run without a visible window
 */

import { chromium } from 'playwright';
import { mkdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const DEFAULT_URL = 'http://localhost:5173';
const DEFAULT_OUT = 'temp/screenshot.png';
const DEFAULT_WAIT = 1500;

/** Resolve a usable Chromium executable.  Prefers the Playwright-managed
 *  build; falls back to a system-installed chromium when the bundled binary
 *  is incompatible with the host libc (e.g. Alpine / musl). */
function resolveChromiumPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const candidates = [
    path.join(home, '.cache', 'ms-playwright', 'chromium-1178', 'chrome-linux', 'chrome'),
    path.join(home, '.cache', 'ms-playwright', 'chromium-1148', 'chrome-linux', 'chrome'),
  ];
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { stdio: 'pipe' });
      return c;
    } catch { /* not usable — try next */ }
  }
  const systemPaths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'];
  for (const sp of systemPaths) {
    try {
      statSync(sp);
      return sp;
    } catch { /* not present */ }
  }
  return undefined;
}

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    out: DEFAULT_OUT,
    wait: DEFAULT_WAIT,
    headed: true,
    selector: null,
    width: 1440,
    height: 900,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--url':
        args.url = argv[++i];
        break;
      case '--out':
        args.out = argv[++i];
        break;
      case '--wait':
        args.wait = parseInt(argv[++i], 10);
        break;
      case '--headless':
        args.headed = false;
        break;
      case '--headed':
        args.headed = true;
        break;
      case '--selector':
        args.selector = argv[++i];
        break;
      case '--width':
        args.width = parseInt(argv[++i], 10);
        break;
      case '--height':
        args.height = parseInt(argv[++i], 10);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return args;
}

async function main() {
  const opts = parseArgs(process.argv);

  const channel = resolveChromiumPath();
  console.log(`Launching ${opts.headed ? 'headed' : 'headless'} Chromium…${channel ? ` (${channel})` : ''}`);
  const browser = await chromium.launch({
    headed: opts.headed,
    executablePath: channel,
    args: channel?.includes('ms-playwright') ? [] : ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  console.log(`Navigating to ${opts.url}…`);
  await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30_000 });

  if (opts.wait > 0) {
    console.log(`Waiting ${opts.wait} ms for UI to settle…`);
    await page.waitForTimeout(opts.wait);
  }

  const outDir = path.dirname(opts.out);
  mkdirSync(outDir, { recursive: true });

  if (opts.selector) {
    console.log(`Screenshotting element: ${opts.selector}`);
    const el = page.locator(opts.selector);
    await el.waitFor({ state: 'visible', timeout: 10_000 });
    await el.screenshot({ path: opts.out });
  } else {
    console.log('Taking full-page screenshot…');
    await page.screenshot({ path: opts.out, fullPage: true });
  }

  console.log(`Screenshot saved to ${path.resolve(opts.out)}`);
  await browser.close();
}

main().catch((err) => {
  console.error('Screenshot failed:', err.message);
  process.exit(1);
});
