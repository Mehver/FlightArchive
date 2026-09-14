// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { createReadStream, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconDir = path.resolve(here, 'public');

/**
 * Serves the pinned, self-contained OpenCV.js runtime (Apache-2.0,
 * `@techstark/opencv-js` production dependency) at the same-origin path
 * `/opencv/opencv.js` without bundling its ~11 MB into the main chunk and
 * without committing the generated file.
 *
 * - `pnpm dev`: streamed straight from `node_modules` via middleware.
 * - `pnpm build`: copied into `build/opencv/opencv.js` so the Python backend
 *   serves it as a regular static file.
 *
 * The crop & layout worker imports this script only for Detect/Crop requests.
 */
function opencvStatic(): Plugin {
  const source = path.join(here, 'node_modules', '@techstark', 'opencv-js', 'dist', 'opencv.js');
  return {
    name: 'flightarchive-opencv-static',
    configureServer(server) {
      server.middlewares.use('/opencv/opencv.js', (_req, res) => {
        const stream = createReadStream(source);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Not Found');
          } else {
            res.destroy();
          }
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        stream.pipe(res);
      });
    },
    writeBundle(options) {
      const target = path.join(options.dir ?? path.join(here, 'build'), 'opencv', 'opencv.js');
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    },
  };
}

/** Runtime brand files kept in the frontend build context. Only the two files
 *  actually referenced at runtime (`/256.png` logo and `/64.png` favicon) are
 *  served/copied. */
const BRAND_FILES = ['256.png', '64.png'] as const;

function brandAssets(): Plugin {
  return {
    name: 'flightarchive-brand-assets',
    configureServer(server) {
      for (const name of BRAND_FILES) {
        const source = path.join(iconDir, name);
        server.middlewares.use(`/${name}`, (_req, res) => {
          const stream = createReadStream(source);
          stream.on('error', () => {
            if (!res.headersSent) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end('Not Found');
            } else {
              res.destroy();
            }
          });
          res.statusCode = 200;
          res.setHeader('Cache-Control', 'no-cache');
          stream.pipe(res);
        });
      }
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.join(here, 'build');
      for (const name of BRAND_FILES) {
        copyFileSync(path.join(iconDir, name), path.join(outDir, name));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), opencvStatic(), brandAssets()],
  build: {
    // Consumed by the Python backend (python -m flightarchive).
    outDir: 'build',
  },
  test: {
    // Pure helper characterization tests run in node; the few component
    // tests opt into jsdom via a `// @vitest-environment jsdom` docblock.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/res': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/images': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
