// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Module wrapper around the classic-script document edge detector
 * (`docDetector.js`). The detector is a plain global script (no
 * `import`/`export`) so the demos can load it with a `<script>` tag; this
 * wrapper side-effect-imports it and re-exports a typed `DocDetect` for the
 * dedicated scan worker, where OpenCV runs off the main thread.
 */

import './docDetector.js';
import type { DocDetectAPI } from './docDetector.js';

export type { DocDetectMethod, DocDetectPoint, DocDetectResult, DocDetectAPI } from './docDetector.js';

export const DocDetect = (globalThis as unknown as { DocDetect: DocDetectAPI }).DocDetect;
