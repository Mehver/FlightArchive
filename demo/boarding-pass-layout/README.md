# Boarding-pass layout demo

Fully standalone three-step crop-and-place demo: detect/crop a boarding pass, align it onto an SVG background template, and preview the final composite. Cropping uses the production in-bounds rotated-rectangle contract: `{centerX, centerY, width, height, rotationDegrees}`.

## Run

This demo fetches local SVG templates, so do not open it with `file://`. Run a local HTTP server from this directory:

```shell
python -m http.server 8000
```

Then open http://localhost:8000/. The OpenCV.js runtime is loaded from CDN fallbacks and requires internet access.

## What it does

1. **Crop** — detect the boarding-pass edges, fine-tune the rotated rectangle, and sample it at its selected width and height.
2. **Place** — pick a background template from `templates/` and position, scale, and rotate the crop onto it.
3. **Effect** — preview the masked composite and download the result. The crop portion of its generated JSON uses the rotated-rectangle contract.

## Files

- `index.html` — the demo (loads OpenCV.js and the detector, then runs the UI).
- `templates/*.svg` — the 11 local boarding-pass background layout templates.
- `docDetector.js` — the demo's local detector copy (classic script, exposes `globalThis.DocDetect`). The demo has no dependency on application source code; OpenCV.js is loaded from CDN fallbacks.

## License

BSD 3-Clause, Copyright (c) 2026 Mehver (https://github.com/Mehver). OpenCV.js is Apache-2.0.
