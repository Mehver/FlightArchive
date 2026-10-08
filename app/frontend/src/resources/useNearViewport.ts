// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useRef, useState } from 'react';

/** Gates raster work to elements in or near the viewport and turns it off again
 * when they leave, allowing consumers to abort requests and release blob URLs. */
export function useNearViewport<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [enabled, setEnabled] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') { setEnabled(true); return; }
    const observer = new IntersectionObserver(([entry]) => setEnabled(entry?.isIntersecting ?? false), { rootMargin: '250px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, enabled };
}
