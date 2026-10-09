// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useRef, useState } from 'react';

/** Starts raster work once an element first approaches the viewport. The gate
 * is sticky so scrolling away never tears down an already loaded image. */
export function useNearViewport<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [enabled, setEnabled] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') { setEnabled(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setEnabled(true);
        observer.disconnect();
      }
    }, { rootMargin: '250px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, enabled };
}
