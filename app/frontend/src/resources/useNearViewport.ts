// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useRef, useState } from 'react';

/** Allows pending raster work only while the element is actually in view.
 * Loaded URL retention belongs to the image hook, not this visibility gate. */
export function useNearViewport<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [enabled, setEnabled] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') { setEnabled(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      setEnabled(Boolean(entry?.isIntersecting));
    }, { rootMargin: '0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, enabled };
}
