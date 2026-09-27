// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ResourceReviewSnapshot } from '../api/types';

/** Shared request lifecycle for resource review consumers.
 * New loads abort old loads and only the newest generation may publish state. */
export function useResourceReview() {
  const [snapshot, setSnapshot] = useState<ResourceReviewSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);

  const load = useCallback(async ({ reconcile = false, clear = false }: { reconcile?: boolean; clear?: boolean } = {}) => {
    const current = ++generation.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    if (clear) setSnapshot(null);
    setLoading(true);
    setError(null);
    try {
      const next = await (reconcile ? api.reconcileResources(controller.signal) : api.getResourceReview(controller.signal));
      if (!controller.signal.aborted && generation.current === current) setSnapshot(next);
      return next;
    } catch (problem) {
      if (!controller.signal.aborted && generation.current === current) setError(problem);
      throw problem;
    } finally {
      if (!controller.signal.aborted && generation.current === current) setLoading(false);
    }
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    active.current?.abort();
    active.current = null;
    setLoading(false);
  }, []);

  useEffect(() => () => {
    generation.current += 1;
    active.current?.abort();
  }, []);

  return { snapshot, loading, error, revision: snapshot?.revision ?? null, load, cancel };
}
