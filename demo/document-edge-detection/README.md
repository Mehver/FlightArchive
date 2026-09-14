# Document edge detection demo

Fully standalone demo that detects the edges of a photographed document (for example, a boarding pass) with four algorithms and samples an in-bounds rotated rectangle using the production crop contract: `{centerX, centerY, width, height, rotationDegrees}`.

## Run

Open `index.html` directly in a browser; this demo loads OpenCV.js from CDN fallbacks and does not fetch local files. It requires internet access. To serve it over HTTP instead, run this command from this directory:

```shell
python -m http.server 8000
```

Then open http://localhost:8000/.

## What it does

1. Upload an image (any format the browser can decode).
2. Pick an algorithm — adaptive threshold, Canny edges, Sobel gradients, or Laplacian of Gaussian.
3. Click **检测边缘** to detect the document contour.
4. Fine-tune the crop rectangle (drag inside to move, drag a corner to resize, zoom and rotate), then click **裁切并展示**.
5. Download the rotated-rectangle crop.

## Files

- `index.html` — the demo (loads OpenCV.js and the detector, then runs the UI).
- `docDetector.js` — the demo's local detector copy (classic script, exposes `globalThis.DocDetect`). The demo has no dependency on application source code; OpenCV.js is loaded from CDN fallbacks.

## License

BSD 3-Clause, Copyright (c) 2026 Mehver (https://github.com/Mehver). OpenCV.js is Apache-2.0.
