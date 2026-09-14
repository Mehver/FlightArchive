# Demos

Standalone, browser-run developer demos for the boarding-pass document edge detection and layout pipeline. They are **not** part of the application build. Each demo loads its pinned OpenCV.js runtime from public CDN fallbacks and its classic-script detector from the demo directory.

The demos illustrate crop/layout interaction, not backend persistence or RFG resource lifecycle. For those production contracts, see [`../docs/BUSINESS_DATA.md`](../docs/BUSINESS_DATA.md) and [`../docs/RESOURCE_LIFECYCLE.md`](../docs/RESOURCE_LIFECYCLE.md).

Both demos use the production in-bounds rotated-rectangle crop contract: `{centerX, centerY, width, height, rotationDegrees}`. Their visible handles are derived from that rectangle, and crop sampling preserves the selected width, height, and clockwise Canvas rotation.

| Directory | Purpose |
| --- | --- |
| [`document-edge-detection/`](document-edge-detection/) | Detect a document edge and refine/sample an in-bounds rotated rectangle. |
| [`boarding-pass-layout/`](boarding-pass-layout/) | Detect and sample an in-bounds rotated rectangle, then place it on a template preview. |

## Running a demo

The demos require internet access for OpenCV.js but do not require `pnpm`, `node_modules`, or an application build. The document-edge demo can be opened directly as `file://`. The layout demo fetches local SVG templates, so serve it over HTTP. From the repository root:

```shell
python -m http.server 8000
```

Then open, for example:

```
http://localhost:8000/demo/document-edge-detection/
http://localhost:8000/demo/boarding-pass-layout/
```

OpenCV.js is downloaded from a CDN at runtime. Only the layout demo requires a local HTTP server because it fetches its SVG templates.

## License

The detector, the two demos, and the layout templates are BSD 3-Clause, Copyright (c) 2026 Mehver (https://github.com/Mehver). OpenCV.js is Apache-2.0 (`@techstark/opencv-js`). See the repository `LICENSE` file.
