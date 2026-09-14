// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * BSD 3-Clause License
 * 
 * Copyright (c) 2026 Mehver (https://github.com/Mehver). All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
// In an ESM (module) context bare `cv` references are a strict-mode
// ReferenceError unless declared.  Use a Proxy that resolves every property
// access against the current globalThis.cv so the binding stays live even when
// OpenCV initialises asynchronously after this module is imported.  In a
// classic-script context globalThis.cv is already reachable through the scope
// chain; the Proxy is lightweight and functionally equivalent.
const cv = new Proxy({}, {
  get(_target, prop, receiver) {
    return Reflect.get(globalThis.cv, prop, globalThis.cv);
  },
  has(_target, prop) { return prop in globalThis.cv; },
});

const DocDetect = (() => {
  const CFG = {
    DOWNSAMPLE: 16,
    MARGIN_RATIO: 0.075,
    Z_THRESHOLD: 2.0,
    CORNER_PATCH_FRAC: 0.04,
    CANNY_LOW: 50,
    CANNY_HIGH: 150,
  };

  function boxPoints(rect) {
    const cx = rect.center.x;
    const cy = rect.center.y;
    const w = rect.size.width;
    const h = rect.size.height;
    const a = rect.angle * Math.PI / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const ds = CFG.DOWNSAMPLE;
    const hw = w / 2, hh = h / 2;
    return [
      { x: (cx - hw * cos + hh * sin) * ds, y: (cy - hw * sin - hh * cos) * ds },
      { x: (cx + hw * cos + hh * sin) * ds, y: (cy + hw * sin - hh * cos) * ds },
      { x: (cx + hw * cos - hh * sin) * ds, y: (cy + hw * sin + hh * cos) * ds },
      { x: (cx - hw * cos - hh * sin) * ds, y: (cy - hw * sin + hh * cos) * ds },
    ];
  }

  let cvReady = false;

  /**
     * Require the local OpenCV runtime to already be loaded (by the worker's
     * `importScripts` or a demo `<script>` tag). No external CDN fetching is
     * performed.
   */
  async function ensureCv() {
    if (cvReady) return;

    // The local OpenCV.js runtime exposes globalThis.cv once its WASM
    // module is ready.  In both the demo HTML pages and the production
    // Vite app the <script> tag / loader runs before any detection call,
    // so the runtime should already be available by the time we reach
    // this check.
    if (globalThis.cv && globalThis.cv.Mat && globalThis.cv.imread) {
      cvReady = true;
      return;
    }

    throw new Error(
      'Local OpenCV.js runtime not found on globalThis.cv. ' +
      'Ensure the pinned @techstark/opencv-js script is loaded before ' +
      'calling DocDetect (see demo/README.md for demo setup).'
    );
  }

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function orderPoints(pts) {
    const sums = pts.map(p => p.x + p.y);
    const diffs = pts.map(p => p.x - p.y);
    const tl = pts[sums.indexOf(Math.min(...sums))];
    const br = pts[sums.indexOf(Math.max(...sums))];
    const tr = pts[diffs.indexOf(Math.min(...diffs))];
    const bl = pts[diffs.indexOf(Math.max(...diffs))];
    return [tl, tr, br, bl];
  }

  function toCvPoint(p) { return new cv.Point(p.x, p.y); }

  function safeDelete(...mats) {
    mats.forEach(m => { if (m) try { m.delete(); } catch (e) { /* ignore */ } });
  }

  /**
   * Convert an image source to an OpenCV Mat without calling `cv.imread` on an
   * OffscreenCanvas. The pinned OpenCV build probes `HTMLImageElement` before
   * checking its input type; that DOM global is absent in dedicated workers.
   * Reading the canvas pixels ourselves avoids that probe while retaining
   * `cv.imread` for the browser demo's regular image and canvas sources.
   */
  function matFromImageSource(img) {
    // `OffscreenCanvas` itself is not defined in every environment. Keep the
    // constructor reference behind typeof so this classic script also loads in
    // workers and non-DOM test environments.
    if (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas) {
      const context = img.getContext('2d');
      if (!context) throw new Error('offscreen-canvas-unavailable');
      return cv.matFromImageData(context.getImageData(0, 0, img.width, img.height));
    }
    return cv.imread(img);
  }

  function normAngle(a) {
    let v = ((a % 360) + 540) % 360 - 180;
    if (v > 90) v -= 180; else if (v < -90) v += 180;
    return v;
  }

  function buildResult(rect, bgMean, bgStd) {
    const cx = rect.center.x * CFG.DOWNSAMPLE;
    const cy = rect.center.y * CFG.DOWNSAMPLE;

    const dim1 = rect.size.width * CFG.DOWNSAMPLE;
    const dim2 = rect.size.height * CFG.DOWNSAMPLE;
    const widthIsLong = rect.size.width > rect.size.height;
    const shortDim = widthIsLong ? dim2 : dim1;
    const longDim  = widthIsLong ? dim1 : dim2;

    const rawShortAngle = widthIsLong ? rect.angle - 90 : rect.angle;
    const rawLongAngle  = widthIsLong ? rect.angle : rect.angle - 90;

    const nShort = normAngle(rawShortAngle);
    const nLong  = normAngle(rawLongAngle);

    let rw, rh, visualTilt;
    if (Math.abs(nShort) <= 45) {
      rw = shortDim; rh = longDim; visualTilt = nShort;
    } else {
      rw = longDim; rh = shortDim; visualTilt = nLong;
    }
    if (visualTilt > 45) visualTilt -= 90;
    else if (visualTilt < -45) visualTilt += 90;
    const rotation = Math.round(visualTilt * 100) / 100;

    const boxPts = boxPoints(rect);
    const ordered = orderPoints(boxPts);

    return {
      center: { x: Math.round(cx * 100) / 100, y: Math.round(cy * 100) / 100 },
      size: { width: Math.round(rw * 100) / 100, height: Math.round(rh * 100) / 100 },
      rotation: rotation,
      corners: {
        top_left: ordered[0], top_right: ordered[1],
        bottom_right: ordered[2], bottom_left: ordered[3],
      },
      boxPoints: boxPts,
      bgStats: { mean: Math.round(bgMean * 100) / 100, std: Math.round(bgStd * 100) / 100 },
    };
  }

  function findDocumentContour(mask) {
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
    k.delete();

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    if (contours.size() === 0) {
      safeDelete(contours, hierarchy);
      return null;
    }

    let maxIdx = 0, maxArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i));
      if (area > maxArea) { maxArea = area; maxIdx = i; }
    }

    const cont = contours.get(maxIdx);
    const rect = cv.minAreaRect(cont);
    safeDelete(contours, hierarchy);
    return rect;
  }

  const METHODS = {
    async adaptive(gray, dw, dh) {
      const mx = Math.round(dw * CFG.MARGIN_RATIO);
      const my = Math.round(dh * CFG.MARGIN_RATIO);
      const iw = dw - 2 * mx;
      const ih = dh - 2 * my;
      const cwp = Math.max(6, Math.round(iw * CFG.CORNER_PATCH_FRAC));
      const chp = Math.max(6, Math.round(ih * CFG.CORNER_PATCH_FRAC));

      const rects = [
        new cv.Rect(mx, my, cwp, chp),
        new cv.Rect(dw - mx - cwp, my, cwp, chp),
        new cv.Rect(mx, dh - my - chp, cwp, chp),
        new cv.Rect(dw - mx - cwp, dh - my - chp, cwp, chp),
      ];

      const patchMats = [], means = [], stds = [];
      for (const r of rects) {
        const patch = gray.roi(r);
        patchMats.push(patch);
        const mean = new cv.Mat(), std = new cv.Mat();
        cv.meanStdDev(patch, mean, std);
        means.push(mean.data64F[0]);
        stds.push(std.data64F[0]);
        mean.delete();
        std.delete();
      }
      patchMats.forEach(m => m.delete());

      const bgMean = median(means);
      const bgStd = median(stds);

      const thrLo = bgMean - CFG.Z_THRESHOLD * bgStd;
      const thrHi = bgMean + CFG.Z_THRESHOLD * bgStd;

      const bright = new cv.Mat();
      const dark = new cv.Mat();
      cv.threshold(gray, bright, thrHi, 255, cv.THRESH_BINARY);
      cv.threshold(gray, dark, thrLo, 255, cv.THRESH_BINARY_INV);

      const mask = new cv.Mat();
      cv.bitwise_or(bright, dark, mask);
      bright.delete();
      dark.delete();

      const roi = cv.Mat.zeros(dh, dw, cv.CV_8UC1);
      cv.rectangle(roi, new cv.Point(mx, my), new cv.Point(dw - mx, dh - my), [255, 255, 255, 255], -1);
      cv.bitwise_and(mask, roi, mask);
      roi.delete();

      const rect = findDocumentContour(mask);
      mask.delete();
      if (!rect) return null;

      return buildResult(rect, bgMean, bgStd);
    },

    async canny(gray, dw, dh) {
      const edges = new cv.Mat();
      cv.Canny(gray, edges, CFG.CANNY_LOW, CFG.CANNY_HIGH);

      const mx = Math.round(dw * CFG.MARGIN_RATIO);
      const my = Math.round(dh * CFG.MARGIN_RATIO);
      const roi = cv.Mat.zeros(dh, dw, cv.CV_8UC1);
      cv.rectangle(roi, new cv.Point(mx, my), new cv.Point(dw - mx, dh - my), [255, 255, 255, 255], -1);
      cv.bitwise_and(edges, roi, edges);
      roi.delete();

      const rect = findDocumentContour(edges);
      edges.delete();
      if (!rect) return null;

      return buildResult(rect, 0, 0);
    },

    async sobel(gray, dw, dh) {
      const gradX = new cv.Mat();
      const gradY = new cv.Mat();
      const absGradX = new cv.Mat();
      const absGradY = new cv.Mat();
      cv.Sobel(gray, gradX, cv.CV_16S, 1, 0);
      cv.Sobel(gray, gradY, cv.CV_16S, 0, 1);
      cv.convertScaleAbs(gradX, absGradX);
      cv.convertScaleAbs(gradY, absGradY);
      gradX.delete();
      gradY.delete();

      const grad = new cv.Mat();
      cv.addWeighted(absGradX, 0.5, absGradY, 0.5, 0, grad);
      absGradX.delete();
      absGradY.delete();

      const binary = new cv.Mat();
      cv.threshold(grad, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      grad.delete();

      const mx = Math.round(dw * CFG.MARGIN_RATIO);
      const my = Math.round(dh * CFG.MARGIN_RATIO);
      const roi = cv.Mat.zeros(dh, dw, cv.CV_8UC1);
      cv.rectangle(roi, new cv.Point(mx, my), new cv.Point(dw - mx, dh - my), [255, 255, 255, 255], -1);
      cv.bitwise_and(binary, roi, binary);
      roi.delete();

      const rect = findDocumentContour(binary);
      binary.delete();
      if (!rect) return null;

      return buildResult(rect, 0, 0);
    },

    async laplacian(gray, dw, dh) {
      const blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 1.5);

      const lap = new cv.Mat();
      cv.Laplacian(blurred, lap, cv.CV_16S, 3);
      blurred.delete();

      const absLap = new cv.Mat();
      cv.convertScaleAbs(lap, absLap);
      lap.delete();

      const binary = new cv.Mat();
      cv.threshold(absLap, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      absLap.delete();

      const mx = Math.round(dw * CFG.MARGIN_RATIO);
      const my = Math.round(dh * CFG.MARGIN_RATIO);
      const roi = cv.Mat.zeros(dh, dw, cv.CV_8UC1);
      cv.rectangle(roi, new cv.Point(mx, my), new cv.Point(dw - mx, dh - my), [255, 255, 255, 255], -1);
      cv.bitwise_and(binary, roi, binary);
      roi.delete();

      const rect = findDocumentContour(binary);
      binary.delete();
      if (!rect) return null;

      return buildResult(rect, 0, 0);
    },
  };

  async function detectWith(img, methodName) {
    await ensureCv();

    let src = null, ds = null, gray = null;
    try {
      src = matFromImageSource(img);
      const h = src.rows, w = src.cols;
      const dw = Math.round(w / CFG.DOWNSAMPLE);
      const dh = Math.round(h / CFG.DOWNSAMPLE);

      ds = new cv.Mat();
      cv.resize(src, ds, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);

      gray = new cv.Mat();
      cv.cvtColor(ds, gray, cv.COLOR_RGBA2GRAY);

      const result = await METHODS[methodName](gray, dw, dh);
      return result || null;
    } finally {
      safeDelete(src, ds, gray);
    }
  }

  return {
    load: ensureCv,
    detect: (img) => detectWith(img, 'adaptive'),
    detectWith,
    matFromImageSource,
    METHODS: Object.keys(METHODS),
  };
})();

// Classic-script entry point: expose the detector as a side-effect global so
// it can be loaded by <script> in the demos and, through `docDetect.ts`, by the
// dedicated scan worker. This file deliberately contains no `import`/`export`
// so it also evaluates cleanly as a non-module script.
globalThis.DocDetect = DocDetect;
