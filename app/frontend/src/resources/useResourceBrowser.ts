// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MappingEntry } from '../rfg/api';
import { useResourceMapping } from '../rfg/ResourceMappingProvider';
import type { ResourceInventoryRow } from '../rfg/mapping';
import type { TranslationKey } from '../i18n';
import { toMappingRows } from './mappingRows';
import { isPendingInbox } from './resourcePaths';

export type ResourceBrowserView = 'thumbnails' | 'list';

export interface ResourceBrowserItem {
  readonly entry: MappingEntry;
  readonly resource: ResourceInventoryRow;
}

export type ResourceBrowserFilter = (item: ResourceBrowserItem) => boolean;
export type ResourceBrowserOrder = (left: ResourceBrowserItem, right: ResourceBrowserItem) => number;

/** Bounded page size so only this many cards/rows render at once. */
const RESOURCE_PICKER_PAGE_SIZE = 24;

/** The picker-compatible ordering: pending inbox resources first, then path. */
export const inboxFirstResourceOrder: ResourceBrowserOrder = (left, right) =>
  Number(isPendingInbox(right.entry.virtual_path)) - Number(isPendingInbox(left.entry.virtual_path))
  || left.entry.virtual_path.localeCompare(right.entry.virtual_path);

export interface UseResourceBrowserOptions {
  /** Whether the owning shell is active. A false -> true edge starts a fresh session. */
  active: boolean;
  initialSelected?: readonly string[];
  multiple?: boolean;
  /** Additional caller-owned visibility policy. Ignored and stale pending rows are always hidden. */
  filter?: ResourceBrowserFilter;
  /** Defaults to inbox-first ordering. */
  order?: ResourceBrowserOrder;
  pageSize?: number;
}

export function useResourceBrowser({
  active,
  initialSelected = [],
  multiple = false,
  filter,
  order = inboxFirstResourceOrder,
  pageSize = RESOURCE_PICKER_PAGE_SIZE,
}: UseResourceBrowserOptions) {
  const mapping = useResourceMapping();
  const [picked, setPicked] = useState<string[]>([...initialSelected]);
  const [query, setQueryState] = useState('');
  const [page, setPage] = useState(1);
  const [view, setView] = useState<ResourceBrowserView>('thumbnails');
  const [error, setError] = useState<TranslationKey | null>(null);
  const session = useRef(0);

  useEffect(() => {
    const current = ++session.current;
    if (!active) return;
    setPicked([...initialSelected]);
    setQueryState('');
    setError(null);
    setPage(1);
    // Browsing remains read-only with respect to form drafts and managed names;
    // refresh independently registers newly scanned catalog files in inbox.
    void mapping.refresh()
      .then(() => {
        if (session.current !== current) return;
      })
      .catch(() => {
        if (session.current === current) setError('resourceLoadFailed');
      });
    // The initial selection is intentionally captured only when a session opens.
    // Parent rerenders must not discard in-progress browser state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const items = useMemo<ResourceBrowserItem[]>(() => toMappingRows(mapping.inventory).map((row) =>
    ({ entry: row.entry, resource: row.resource })), [mapping.inventory]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter((item) => item.resource.state !== 'ignored' && !(item.resource.state === 'pending' && !item.resource.present))
      .filter((item) => !filter || filter(item))
      .filter((item) => !needle || item.entry.virtual_path.toLowerCase().includes(needle))
      .sort(order);
  }, [filter, items, order, query]);

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageFrom = visible.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const pageTo = Math.min(currentPage * pageSize, visible.length);
  const paged = useMemo(
    () => visible.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [currentPage, pageSize, visible],
  );

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setPage(1);
  }, []);

  const toggle = useCallback((path: string, unavailable = false) => {
    if (unavailable) return;
    setPicked((previous) => multiple
      ? previous.includes(path) ? previous.filter((item) => item !== path) : [...previous, path]
      : previous.includes(path) ? [] : [path]);
  }, [multiple]);

  return {
    picked, query, setQuery, page: currentPage, setPage, view, setView, error,
    items, visible, paged, pageCount, pageFrom, pageTo, toggle,
    loading: mapping.loading && mapping.mapping === null,
  };
}

export type ResourceBrowserModel = ReturnType<typeof useResourceBrowser>;
