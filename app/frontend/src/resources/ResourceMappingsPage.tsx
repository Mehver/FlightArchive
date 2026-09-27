// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Review resource status and usage, rematch missing sources, calculate
 * business-resource fingerprints, or release unreferenced present objects back to Pending. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Stack,
  Tab,
  TableCell,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import FindReplaceIcon from '@mui/icons-material/FindReplace';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { api, ApiError } from '../api/client';
import type { ResourceUse } from '../api/types';
import { HASH_ALGORITHMS, type HashAlgorithm } from '../rfg/api';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useTranslation, type TranslationKey } from '../i18n';
import { useAppState } from '../state/AppState';
import { formatBytes } from '../utils/format';
import {
  toMappingRows,
  countMappingRows,
  rematchCandidates,
  rematchTargets,
  type MappingRow,
  type MappingRowFilter,
  type MappingRowKind,
} from './mappingRows';
import {
  chunkVirtualPaths,
  fingerprintRowState,
  fingerprintTargets,
} from './fingerprints';
import { ALGORITHM_LABEL, FingerprintDialog, HashPresenceChips } from './FingerprintDialog';
import { SearchHighlight } from './SearchHighlight';
import { AutoRematchDialog, type AutoMatchAlgorithm } from './AutoRematchDialog';
import { ResourcePickerDialog } from './ResourcePickerDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { FeedbackContext } from '../feedback/FeedbackCenter';
import { resourceUsageCounts, usageRoleKey } from './resourceUsage';
import { useResourceReview } from './useResourceReview';
import { MarqueeCopyText } from './MarqueeCopyText';
import {
  formatMappingPath,
  MappingHeaderCell,
  MappingRowActions,
  MappingStatusChip,
  MappingTable,
  type MappingPathDisplayMode,
} from './MappingTable';

const KIND_LABEL: Record<MappingRowKind, TranslationKey> = {
  paired: 'mappingStatusMapped',
  inbox: 'mappingStatusInbox',
  ignored: 'mappingStatusIgnored',
  missing: 'mappingStatusMissing',
  local_only: 'mappingStatusLocalOnly',
};

type AutoRematchScope = {
  initialCandidatePaths: string[];
  targetPaths: string[];
};

type FirstSortField = 'status' | 'usage' | 'fingerprints';
type SecondSortField = 'virtualPath' | 'localPath' | 'size';
type SortDirection = 'asc' | 'desc';

const STATUS_SORT_ORDER: Record<MappingRowKind, number> = {
  missing: 0,
  inbox: 1,
  paired: 2,
  ignored: 3,
  local_only: 4,
};

/** One source of truth for both searchable and rendered row sizes. */
export function sizeOf(row: MappingRow): number | null {
  return row.review.sizeBytes;
}

export function ResourceMappingsPage() {
  const { t } = useTranslation();
  const { notify, showError } = useAppState();
  const review = useResourceReview();
  const [filter, setFilter] = useState<MappingRowFilter | 'rebuild'>('all');
  const [search, setSearch] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [firstSort, setFirstSort] = useState<{ field: FirstSortField; direction: SortDirection } | null>({ field: 'status', direction: 'asc' });
  const [secondSort, setSecondSort] = useState<{ field: SecondSortField; direction: SortDirection }>({ field: 'virtualPath', direction: 'asc' });
  const [pathDisplay, setPathDisplay] = useState<Record<'virtualPath' | 'localPath', MappingPathDisplayMode>>({ virtualPath: 0, localPath: 0 });
  const [autoRematchScope, setAutoRematchScope] = useState<AutoRematchScope | null>(null);
  const [autoRematchBusy, setAutoRematchBusy] = useState(false);
  const [manualTargetPath, setManualTargetPath] = useState<string | null>(null);
  const [manualRematchBusy, setManualRematchBusy] = useState(false);
  const manualRematchInFlight = useRef(false);
  const [fingerprintOpen, setFingerprintOpen] = useState(false);
  const [fingerprintPaths, setFingerprintPaths] = useState<string[]>([]);
  const [fingerprintBusy, setFingerprintBusy] = useState(false);
  const [fingerprintError, setFingerprintError] = useState<string | null>(null);
  const [releasePaths, setReleasePaths] = useState<string[] | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const releaseInFlight = useRef(false);
  const [unignoreBusy, setUnignoreBusy] = useState(false);
  const [ignoreBusy, setIgnoreBusy] = useState(false);
  const tRef = useRef(t);
  const showErrorRef = useRef(showError);
  tRef.current = t;
  showErrorRef.current = showError;

  const load = useCallback(async (background = false, reconcile = false) => {
      try {
        await review.load({ reconcile, clear: !background });
      } catch (error) {
        if (background) showErrorRef.current(error, tRef.current('mappingLoadFailed'), { action: tRef.current('mappingRefresh'), form: tRef.current('resourceMappings') });
      }
    }, [review.load]);

  useEffect(() => {
    void load(false, true);
  }, [load]);

  const rows = useMemo(
    () => toMappingRows(review.snapshot?.rows ?? []),
    [review.snapshot],
  );
  const counts = useMemo(() => countMappingRows(rows), [rows]);
  const targets = useMemo(() => rematchTargets(rows), [rows]);
  const candidates = useMemo(() => rematchCandidates(rows), [rows]);
  const usageLabel = (uses: readonly ResourceUse[]) => {
    if (!uses.length) return t('mappingUsageNone');
    const { flights, airlines } = resourceUsageCounts(uses);
    return [
      t(flights === 1 ? 'mappingUsageFlightOne' : 'mappingUsageFlightMany', { count: flights }),
      t(airlines === 1 ? 'mappingUsageAirlineOne' : 'mappingUsageAirlineMany', { count: airlines }),
    ].join(' · ');
  };
  const usageDetails = (uses: readonly ResourceUse[]) => uses.map((use) =>
    use.kind === 'flight'
      ? t('mappingUsageFlight', { flight: `${use.airlineCode}${use.flightNumber}`, date: use.departureDate, role: t(usageRoleKey(use.role)) })
      : t('mappingUsageAirline', { code: use.code, role: t(usageRoleKey(use.role)) }),
  ).join('\n');
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (row: MappingRow) => {
      const rowUsage = row.review.uses;
      const fingerprint = fingerprintRowState(row);
      const fingerprintText = fingerprint.kind === 'referenced' ? HASH_ALGORITHMS.map((algorithm) => ALGORITHM_LABEL[algorithm]).join(' ') : fingerprint.kind === 'unreferenced' ? t('mappingUnreferenced') : '';
      const size = sizeOf(row);
      const status = row.kind === 'paired' ? t(rowUsage.length ? 'mappingStatusInUse' : 'mappingStatusUnbound') : t(KIND_LABEL[row.kind]);
      const text = [status, row.virtualPath, row.localPath, usageLabel(rowUsage), usageDetails(rowUsage), fingerprintText, typeof size === 'number' ? formatBytes(size, t) : t('notAvailable')].filter(Boolean).join(' ').toLowerCase();
      return !needle || text.includes(needle);
    };
    const filtered = rows.filter((row) => (filter === 'rebuild' ? row.kind === 'missing' || row.kind === 'inbox' : filter === 'all' || row.kind === filter) && matches(row));
    const firstValue = (row: MappingRow) => firstSort?.field === 'status'
      ? STATUS_SORT_ORDER[row.kind]
      : firstSort?.field === 'usage'
        ? Number(row.review.uses.length > 0)
        : Number(row.review.fingerprints.length > 0);
    const compareSecond = (left: MappingRow, right: MappingRow) => {
      const direction = secondSort.direction === 'asc' ? 1 : -1;
      if (secondSort.field === 'size') {
        const leftSize = sizeOf(left), rightSize = sizeOf(right);
        if (leftSize === null) return rightSize === null ? 0 : 1;
        if (rightSize === null) return -1;
        return direction * (leftSize - rightSize);
      }
      const leftPath = secondSort.field === 'virtualPath' ? left.virtualPath ?? '' : left.localPath;
      const rightPath = secondSort.field === 'virtualPath' ? right.virtualPath ?? '' : right.localPath;
      return direction * leftPath.localeCompare(rightPath);
    };
    return [...filtered].sort((left, right) => {
      if (firstSort) {
        const grouped = (firstSort.direction === 'asc' ? 1 : -1) * (firstValue(left) - firstValue(right));
        if (grouped) return grouped;
      }
      return compareSecond(left, right);
    });
  // usage and size text are intentionally searched too, not only paths.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filter, firstSort, search, secondSort, t]);
  const selectablePaths = useMemo(() => new Set(rows.flatMap((row) => {
    const inCurrentFilter = filter === 'rebuild'
      ? row.kind === 'missing' || row.kind === 'inbox'
      : filter !== 'all' && row.kind === filter;
    if (!inCurrentFilter) return [];
    if (!row.virtualPath || filter === 'all' || filter === 'local_only') return [];
    const allowed = filter === 'rebuild'
      ? row.review.capabilities.rematchTarget || row.review.capabilities.rematchCandidate
      : filter === 'missing' ? row.review.capabilities.rematchTarget
       : filter === 'inbox' ? row.review.capabilities.ignore
      : filter === 'ignored' ? row.review.capabilities.unignore
      : filter === 'paired' ? row.review.capabilities.fingerprint
      : false;
    return allowed ? [row.virtualPath] : [];
  })), [rows, filter]);
  useEffect(() => {
    // A refresh temporarily invalidates the view; only prune against complete
    // data, while explicit conflict handling clears reviewed state immediately.
    if (review.snapshot === null) return;
    setSelectedPaths((selected) => selected.filter((path) => selectablePaths.has(path)));
  }, [selectablePaths, review.snapshot]);

  // Any persisted business record (flight or airline) makes an object eligible.
  const eligibleFingerprints = useMemo(() => fingerprintTargets(rows), [rows]);
  // Dialog targets resolve from the *latest* eligible set: after a reload the
  // reviewed selection may be gone (rematch/unbind), which the dialog shows
  // as stale instead of offering a rejected calculation.
  const fingerprintDialogTargets = useMemo(
    () => eligibleFingerprints.filter((target) => fingerprintPaths.includes(target.virtualPath)),
    [eligibleFingerprints, fingerprintPaths],
  );

  const clearReviewedState = () => {
    setSelectedPaths([]);
    setAutoRematchScope(null);
    setManualTargetPath(null);
    setFingerprintOpen(false);
    setFingerprintPaths([]);
    setFingerprintError(null);
    setReleasePaths(null);
  };

  const refreshMappingView = async (context: FeedbackContext = { action: t('mappingRefresh'), form: t('resourceMappings') }) => {
    // Once a mutation has succeeded or its ETag has been rejected, never leave
    // an actionable stale view behind if the follow-up refresh fails.
    try {
      await review.load({ clear: true });
    } catch (error) {
      clearReviewedState();
      const refreshError = error instanceof ApiError && error.code === 'resource-committed-refresh-failed'
        ? error
        : new ApiError(error instanceof ApiError ? error.httpStatus : 0, 'resource-committed-refresh-failed', 'refresh failed');
      showError(refreshError, undefined, context);
    }
  };

  const handleStaleMapping = async (error: unknown, context: FeedbackContext) => {
    if (!(error instanceof ApiError)) return false;
    if (error.httpStatus === 409) {
      clearReviewedState();
      notify(t('mappingConflict'), 'warning', context);
      await refreshMappingView();
      return true;
    }
    if (error.code === 'resource-committed-refresh-failed') {
      clearReviewedState();
      showError(error, undefined, context);
      await refreshMappingView();
      return true;
    }
    return false;
  };

  const applyAutoRematch = async (candidateInboxVirtualPaths: string[], targetVirtualPaths: string[], algorithms: AutoMatchAlgorithm[]) => {
    setAutoRematchBusy(true);
    try {
      const result = await api.rematchResources({ ifMatch: review.revision, mode: 'auto', candidateInboxVirtualPaths, targetVirtualPaths, algorithms });
      notify(t('batchRematchResult', { applied: result.applied, ambiguous: result.ambiguous.length, unmatched: result.unmatched.length }), result.ambiguous.length || result.unmatched.length ? 'warning' : 'success', { action: t('batchRematchAction'), form: t('resourceMappings') });
      setAutoRematchScope(null);
      await refreshMappingView();
    } catch (error) {
      const context = { action: t('batchRematchAction'), form: t('resourceMappings') };
      if (!(await handleStaleMapping(error, context))) showError(error, t('batchRematchFailed'), context);
    } finally { setAutoRematchBusy(false); }
  };

  const applyManualRematch = async (candidateInboxVirtualPath: string) => {
    if (!manualTargetPath || manualRematchInFlight.current) return;
    manualRematchInFlight.current = true;
    const targetVirtualPath = manualTargetPath;
    setManualRematchBusy(true);
    const context = { action: t('manualRematchAction'), resource: targetVirtualPath, form: t('resourceMappings') };
    try {
      await api.rematchResources({
        ifMatch: review.revision,
        mode: 'explicit',
        matches: [{ targetVirtualPath, candidateInboxVirtualPath }],
      });
      notify(t('manualRematchDone'), 'success', context);
      setManualTargetPath(null);
      await refreshMappingView(context);
    } catch (error) {
      if (!(await handleStaleMapping(error, context))) showError(error, t('manualRematchFailed'), context);
    } finally {
      manualRematchInFlight.current = false;
      setManualRematchBusy(false);
    }
  };

  const ignore = async (paths: string[]) => {
    if (!paths.length) return;
    setIgnoreBusy(true);
    try {
      await api.ignoreResource({ ifMatch: review.revision, virtualPaths: paths });
      setSelectedPaths([]);
      await refreshMappingView();
    } catch (error) {
      const context = { action: t('resourceIgnore'), resource: paths.join(', '), form: t('resourceMappings') };
      if (!(await handleStaleMapping(error, context))) showError(error, t('resourceIgnoreFailed'), context);
    } finally { setIgnoreBusy(false); }
  };

  const openFingerprints = (virtualPaths: string[]) => {
    setFingerprintPaths(virtualPaths);
    setFingerprintError(null);
    setFingerprintOpen(true);
  };

  const release = async () => {
    if (!releasePaths?.length || releaseInFlight.current) return;
    releaseInFlight.current = true;
    setReleaseBusy(true);
    try {
      await api.releaseResources({ ifMatch: review.revision, virtualPaths: releasePaths });
      notify(t('mappingReleaseDone', { count: releasePaths.length }), 'success', { action: t('mappingReleaseAction'), form: t('resourceMappings') });
      setReleasePaths(null);
      await refreshMappingView();
    } catch (error) {
      const context = { action: t('mappingReleaseAction'), form: t('resourceMappings') };
      if (!(await handleStaleMapping(error, context))) {
        setReleasePaths(null);
        showError(error, t('mappingReleaseFailed'), context);
      }
    } finally {
      releaseInFlight.current = false;
      setReleaseBusy(false);
    }
  };

  const unignore = async (paths: string[]) => {
    if (!paths.length) return;
    setUnignoreBusy(true);
    try {
      const result = await api.unignoreResources({ ifMatch: review.revision, virtualPaths: paths });
      notify(t('mappingUnignoreDone', { count: result.count }), 'success', { action: t('mappingUnignoreAction', { count: paths.length }), form: t('resourceMappings') });
      setSelectedPaths([]);
      await refreshMappingView();
    } catch (error) {
      const context = { action: t('mappingUnignoreAction', { count: paths.length }), form: t('resourceMappings') };
      if (!(await handleStaleMapping(error, context))) {
        showError(error, t('mappingUnignoreFailed'), context);
      }
    } finally {
      setUnignoreBusy(false);
    }
  };

  const toggleSelected = (path: string) => setSelectedPaths((selected) => selected.includes(path) ? selected.filter((item) => item !== path) : [...selected, path]);

  const openSelectedAutoRematch = () => setAutoRematchScope({
    initialCandidatePaths: filter === 'rebuild'
      ? candidates.filter((item) => selectedPaths.includes(item.virtual_path)).map((item) => item.virtual_path)
      : [],
    targetPaths: targets.filter((item) => selectedPaths.includes(item.virtual_path)).map((item) => item.virtual_path),
  });


  const runFingerprints = async (virtualPaths: string[], algorithms: HashAlgorithm[], forceOverwrite: boolean) => {
    setFingerprintBusy(true);
    setFingerprintError(null);
    try {
      // Enqueue groups matching each target's supported algorithms. The backend
      // caps each request, so a large batch can create several FIFO tasks.
      const targetsByPath = new Map(eligibleFingerprints.map((target) => [target.virtualPath, target]));
      const groups = new Map<string, string[]>();
      for (const path of virtualPaths) {
        const target = targetsByPath.get(path);
        const supported = target?.supported ?? algorithms;
        const feasible = algorithms.filter((algorithm) => supported.includes(algorithm) && (forceOverwrite || !target?.stored.includes(algorithm)));
        if (feasible.length) groups.set(feasible.join(','), [...(groups.get(feasible.join(',')) ?? []), path]);
      }
      const queued = [];
      for (const [key, paths] of groups) for (const chunk of chunkVirtualPaths(paths)) {
        const response = await api.calculateResourceFingerprints({
          ifMatch: review.revision,
          virtualPaths: chunk,
          algorithms: key.split(',') as HashAlgorithm[],
        });
        queued.push(response.task);
      }
      setFingerprintOpen(false);
      notify(t('fingerprintsQueued', { id: queued[0].id, count: queued.reduce((total, task) => total + task.total, 0) }), 'success', { action: t('fingerprintCalculate'), resource: virtualPaths.join(', '), form: t('resourceMappings') });
    } catch (error) {
      const context = { action: t('fingerprintCalculate'), resource: virtualPaths.join(', '), form: t('resourceMappings') };
      if (!(await handleStaleMapping(error, context))) {
        const detail =
          error instanceof ApiError && error.httpStatus > 0
            ? t('apiRequestFailed', { status: error.httpStatus })
            : null;
        setFingerprintError(detail ? `${t('fingerprintsFailed')} — ${detail}` : t('fingerprintsFailed'));
        showError(error, t('fingerprintsFailed'), context);
      }
    } finally {
      setFingerprintBusy(false);
    }
  };

  const filterTabs: { value: MappingRowFilter | 'rebuild'; label: string; count: number }[] = [
    { value: 'all', label: t('mappingFilterAll'), count: rows.length },
    { value: 'rebuild' as const, label: t('mappingRebuild'), count: counts.missing + counts.inbox },
    { value: 'missing', label: t('mappingStatusMissing'), count: counts.missing },
    { value: 'inbox', label: t('mappingStatusInbox'), count: counts.inbox },
    { value: 'ignored', label: t('mappingStatusIgnored'), count: counts.ignored },
    { value: 'paired', label: t('mappingStatusMapped'), count: counts.paired },
    ...(counts.local_only > 0
      ? [{ value: 'local_only' as MappingRowFilter, label: t('mappingStatusLocalOnly'), count: counts.local_only }]
      : []),
  ];
  const rowSelectionLabel: TranslationKey = filter === 'inbox'
    ? 'mappingIgnoreSelect'
    : filter === 'ignored'
      ? 'mappingUnignoreSelect'
      : filter === 'paired'
        ? 'mappingFingerprintSelect'
        : 'mappingRematchSelect';

  const selectSecondSort = (field: SecondSortField) => setSecondSort((current) =>
    current.field === field
      ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { field, direction: 'asc' });
  const selectFirstSortDirection = (field: FirstSortField) => setFirstSort((current) =>
    current?.field === field
      ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { field, direction: 'asc' });
  const selectFirstSortLabel = (field: FirstSortField) => setFirstSort((current) =>
    current?.field === field ? null : { field, direction: 'asc' });
  const cyclePathDisplay = (field: 'virtualPath' | 'localPath') => setPathDisplay((current) => ({
    ...current,
    [field]: ((current[field] + 1) % 3) as MappingPathDisplayMode,
  }));
  const sortDirectionLabel = (column: string, direction: SortDirection) => t('mappingSortDirection', {
    column,
    direction: t(direction === 'asc' ? 'sortAscending' : 'sortDescending'),
  });

  return (
    <Box>
      <PageHeader
        title={t('resourceMappings')}
      />

      {review.snapshot === null ? (
        review.error ? (
          <ErrorState message={t('mappingLoadFailed')} onRetry={() => void load()} />
        ) : (
          <LoadingState label={t('mappingLoading')} />
        )
      ) : (
        <>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mb: 2 }}>
            <MappingStatusChip kind="missing" label={t('mappingSummaryMissing', { count: counts.missing })} />
            {counts.ignored > 0 ? <MappingStatusChip kind="ignored" label={t('mappingSummaryIgnored', { count: counts.ignored })} /> : null}
            <MappingStatusChip kind="inbox" label={t('mappingSummaryInbox', { count: counts.inbox })} />
            <MappingStatusChip kind="paired" label={t('mappingSummaryMapped', { count: counts.paired })} />
            {counts.local_only > 0 ? (
              <MappingStatusChip kind="local_only" label={t('mappingSummaryLocalOnly', { count: counts.local_only })} />
            ) : null}
          </Stack>

          <Box
            sx={{
              display: 'flex',
              alignItems: { xs: 'stretch', sm: 'center' },
              flexDirection: { xs: 'column', sm: 'row' },
              gap: 2,
              mb: 2,
            }}
          >
            <Tabs
              value={filter}
              onChange={(_event, value: MappingRowFilter | 'rebuild') => { setFilter(value); setSelectedPaths([]); }}
              variant="scrollable"
              scrollButtons="auto"
              aria-label={t('mappingFilterLabel')}
              sx={{ minHeight: 40 }}
            >
              {filterTabs.map((tab) => (
                <Tab key={tab.value} value={tab.value} label={`${tab.label} (${tab.count})`} sx={{ minHeight: 40 }} />
              ))}
            </Tabs>
            <TextField
              size="small"
              label={t('mappingSearch')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              sx={{ ml: { sm: 'auto' }, minWidth: { xs: '100%', sm: 240 } }}
            />
            {filter === 'inbox' ? <Button size="small" color="warning" variant="contained" onClick={() => void ignore(selectedPaths)} disabled={ignoreBusy || !selectedPaths.length}>{t('resourceIgnore')} ({selectedPaths.length})</Button> : null}
            {filter === 'ignored' ? <Button size="small" color="primary" variant="contained" onClick={() => void unignore(selectedPaths)} disabled={unignoreBusy || !selectedPaths.length}>{t('mappingUnignoreAction', { count: selectedPaths.length })}</Button> : null}
            {filter === 'paired' ? <Button size="small" color="primary" variant="contained" startIcon={<FingerprintIcon />} onClick={() => openFingerprints(selectedPaths)} disabled={fingerprintBusy || !selectedPaths.some((path) => eligibleFingerprints.some((target) => target.virtualPath === path))}>{t('fingerprintAction')}</Button> : null}
             {filter === 'missing' || filter === 'rebuild' ? <Button size="small" color="primary" variant="contained" startIcon={<FindReplaceIcon />} onClick={openSelectedAutoRematch} disabled={autoRematchBusy || !selectedPaths.some((path) => targets.some((target) => target.virtual_path === path))}>{t('batchRematchAction')}</Button> : null}
          </Box>

          {rows.length === 0 ? (
            <EmptyState title={t('mappingEmpty')} hint={t('mappingEmptyHint')} />
          ) : visible.length === 0 ? (
            <EmptyState title={t('noEntries')} />
          ) : (
            <MappingTable label={t('resourceMappings')} header={
              <TableRow>
                {filter !== 'all' && filter !== 'local_only' ? <MappingHeaderCell padding="checkbox"><Checkbox size="small" checked={selectablePaths.size > 0 && [...selectablePaths].every((path) => selectedPaths.includes(path))} indeterminate={selectedPaths.some((path) => selectablePaths.has(path)) && ![...selectablePaths].every((path) => selectedPaths.includes(path))} disabled={selectablePaths.size === 0} onChange={() => setSelectedPaths((old) => [...selectablePaths].every((path) => old.includes(path)) ? old.filter((path) => !selectablePaths.has(path)) : [...new Set([...old, ...selectablePaths])])} slotProps={{ input: { 'aria-label': t('batchRematchSelectVisible') } }} /></MappingHeaderCell> : null}
                <MappingHeaderCell sortDimension="first" active={firstSort?.field === 'status'} direction={firstSort?.field === 'status' ? firstSort.direction : 'asc'} onLabelClick={() => selectFirstSortLabel('status')} onDirectionClick={() => selectFirstSortDirection('status')} directionAriaLabel={sortDirectionLabel(t('status'), firstSort?.field === 'status' ? firstSort.direction : 'asc')}>{t('status')}</MappingHeaderCell>
                <MappingHeaderCell sortDimension="second" active={secondSort.field === 'virtualPath'} direction={secondSort.field === 'virtualPath' ? secondSort.direction : 'asc'} onLabelClick={() => selectSecondSort('virtualPath')} onDirectionClick={() => selectSecondSort('virtualPath')} directionAriaLabel={sortDirectionLabel(t('mappingVirtualPath'), secondSort.field === 'virtualPath' ? secondSort.direction : 'asc')} pathDisplay={{ mode: pathDisplay.virtualPath, onCycle: () => cyclePathDisplay('virtualPath'), ariaLabel: t('mappingPathDisplayMode', { column: t('mappingVirtualPath'), mode: pathDisplay.virtualPath + 1 }) }}>{t('mappingVirtualPath')}</MappingHeaderCell>
                <MappingHeaderCell sortDimension="second" active={secondSort.field === 'localPath'} direction={secondSort.field === 'localPath' ? secondSort.direction : 'asc'} onLabelClick={() => selectSecondSort('localPath')} onDirectionClick={() => selectSecondSort('localPath')} directionAriaLabel={sortDirectionLabel(t('mappingLocalPath'), secondSort.field === 'localPath' ? secondSort.direction : 'asc')} pathDisplay={{ mode: pathDisplay.localPath, onCycle: () => cyclePathDisplay('localPath'), ariaLabel: t('mappingPathDisplayMode', { column: t('mappingLocalPath'), mode: pathDisplay.localPath + 1 }) }}>{t('mappingLocalPath')}</MappingHeaderCell>
                <MappingHeaderCell sortDimension="first" active={firstSort?.field === 'usage'} direction={firstSort?.field === 'usage' ? firstSort.direction : 'asc'} onLabelClick={() => selectFirstSortLabel('usage')} onDirectionClick={() => selectFirstSortDirection('usage')} directionAriaLabel={sortDirectionLabel(t('mappingUsage'), firstSort?.field === 'usage' ? firstSort.direction : 'asc')}>{t('mappingUsage')}</MappingHeaderCell>
                <MappingHeaderCell sortDimension="first" active={firstSort?.field === 'fingerprints'} direction={firstSort?.field === 'fingerprints' ? firstSort.direction : 'asc'} onLabelClick={() => selectFirstSortLabel('fingerprints')} onDirectionClick={() => selectFirstSortDirection('fingerprints')} directionAriaLabel={sortDirectionLabel(t('mappingFingerprints'), firstSort?.field === 'fingerprints' ? firstSort.direction : 'asc')}>{t('mappingFingerprints')}</MappingHeaderCell>
                <MappingHeaderCell sortDimension="second" active={secondSort.field === 'size'} direction={secondSort.field === 'size' ? secondSort.direction : 'asc'} onLabelClick={() => selectSecondSort('size')} onDirectionClick={() => selectSecondSort('size')} directionAriaLabel={sortDirectionLabel(t('size'), secondSort.field === 'size' ? secondSort.direction : 'asc')}>{t('size')}</MappingHeaderCell>
                <MappingHeaderCell align="right">{t('actions')}</MappingHeaderCell>
              </TableRow>
            }>
                  {visible.map((row) => {
                    const size = sizeOf(row);
                    const fingerprint = fingerprintRowState(row);
                    // Ignored mappings are temporary and cannot be business-bound,
                    // even if corrupt legacy data happens to name one.
                    const rowUsage = row.review.uses;
                    return (
                      <TableRow key={row.key} hover>
                          {filter !== 'all' && filter !== 'local_only' ? <TableCell padding="checkbox">
                             {row.virtualPath && selectablePaths.has(row.virtualPath) ? (
                               <Checkbox
                                 size="small"
                                   slotProps={{ input: { 'aria-label': t(rowSelectionLabel, { path: row.virtualPath }) } }} checked={selectedPaths.includes(row.virtualPath)} onChange={() => toggleSelected(row.virtualPath!)} disabled={ignoreBusy || unignoreBusy || autoRematchBusy || fingerprintBusy}
                               />
                             ) : null}
                          </TableCell> : null}
                           <TableCell sx={{ whiteSpace: 'nowrap' }}><MappingStatusChip kind={row.kind} label={<SearchHighlight text={row.kind === 'paired' ? t(rowUsage.length ? 'mappingStatusInUse' : 'mappingStatusUnbound') : t(KIND_LABEL[row.kind])} query={search} />} unbound={row.kind === 'paired' && rowUsage.length === 0} /></TableCell>
                         <TableCell sx={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                           {row.virtualPath ? (
                             <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                               {row.kind === 'missing' ? (
                                 <Tooltip title={t('rematchPreserved')}>
                                   <LockOutlinedIcon fontSize="small" color="primary" aria-hidden />
                                 </Tooltip>
                               ) : null}
                               <Box sx={{ minWidth: 0, flex: '1 1 auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'caption.fontSize' }}>
                                 <MarqueeCopyText value={row.virtualPath} displayText={formatMappingPath(row.virtualPath, pathDisplay.virtualPath)} query={search} copiedLabel={t('mappingCopied')} ariaLabel={t('mappingCopyField', { field: t('mappingVirtualPath'), value: row.virtualPath })} />
                               </Box>
                             </Box>
                          ) : (
                            <Typography variant="caption" color="text.disabled">
                              {t('notAvailable')}
                            </Typography>
                          )}
                        </TableCell>
                         <TableCell sx={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                           {row.kind === 'missing' ? (
                             <Box sx={{ color: 'error.main', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'caption.fontSize', minWidth: 0, textDecoration: 'line-through' }}>
                               <MarqueeCopyText value={row.localPath} displayText={formatMappingPath(row.localPath, pathDisplay.localPath)} query={search} copiedLabel={t('mappingCopied')} ariaLabel={t('mappingCopyField', { field: t('mappingLocalPath'), value: row.localPath })} />
                             </Box>
                           ) : row.localPath ? (
                             <Box sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'caption.fontSize', minWidth: 0 }}>
                               <MarqueeCopyText value={row.localPath} displayText={formatMappingPath(row.localPath, pathDisplay.localPath)} query={search} copiedLabel={t('mappingCopied')} ariaLabel={t('mappingCopyField', { field: t('mappingLocalPath'), value: row.localPath })} />
                             </Box>
                          ) : (
                            <Typography variant="caption" color="text.disabled">
                              {t('notAvailable')}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell sx={{ maxWidth: 250 }}>
                          {row.virtualPath ? (
                            <Tooltip title={<SearchHighlight text={usageDetails(rowUsage)} query={search} />} disableHoverListener={!rowUsage.length}>
                              <Chip size="small" color={rowUsage.length ? 'primary' : 'default'} variant="outlined" label={<SearchHighlight text={usageLabel(rowUsage)} query={search} />} />
                            </Tooltip>
                          ) : <Typography variant="caption" color="text.disabled">{t('notAvailable')}</Typography>}
                        </TableCell>
                        <TableCell sx={{ maxWidth: 320 }}>
                          {fingerprint.kind === 'hidden' ? (
                            <Typography variant="caption" color="text.disabled">
                              {t('notAvailable')}
                            </Typography>
                          ) : fingerprint.kind === 'unreferenced' ? (
                            <Tooltip title={t('mappingUnreferencedTooltip')}>
                              <Chip size="small" variant="outlined" label={<SearchHighlight text={t('mappingUnreferenced')} query={search} />} />
                            </Tooltip>
                          ) : (
                            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}>
                               {row.entry ? <HashPresenceChips entry={row.entry} storedAlgorithms={row.review.fingerprints} localPath={row.localPath} highlightQuery={search} /> : null}
                            </Box>
                          )}
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                           <SearchHighlight text={size !== null ? formatBytes(size, t) : t('notAvailable')} query={search} />
                        </TableCell>
                         <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                           {filter !== 'all' ? <MappingRowActions>
                           {row.review.capabilities.fingerprint && fingerprint.kind === 'referenced' && fingerprint.calculable ? (
                             <Tooltip title={t('fingerprintActionTooltip')}>
                               <Button
                                 size="small"
                                 color="primary"
                                 variant="outlined"
                                 startIcon={<FingerprintIcon />}
                                onClick={() => row.virtualPath && openFingerprints([row.virtualPath])}
                                disabled={fingerprintBusy}
                              >
                                {t('fingerprintAction')}
                              </Button>
                            </Tooltip>
                          ) : null}
                            {((row.kind === 'missing' && row.review.capabilities.rematchTarget) || row.kind === 'paired') && row.entry ? (
                              <Button
                                size="small"
                                color="primary"
                                variant="outlined"
                                startIcon={<FindReplaceIcon />}
                                onClick={() => setManualTargetPath(row.entry!.virtual_path)}
                                disabled={manualRematchBusy}
                             >
                               {t('manualRematchAction')}
                             </Button>
                            ) : null}
                            {row.review.capabilities.ignore && row.virtualPath ? <Button size="small" color="warning" variant="outlined" onClick={() => void ignore([row.virtualPath!])} disabled={ignoreBusy}>{t('resourceIgnore')}</Button> : null}
                            {row.review.capabilities.unignore && row.virtualPath ? <Button size="small" color="primary" variant="outlined" onClick={() => void unignore([row.virtualPath!])} disabled={unignoreBusy}>{t('mappingUnignoreAction', { count: 1 })}</Button> : null}
                            {row.review.capabilities.release && row.virtualPath ? (
                             <Button size="small" color="error" variant="outlined" onClick={() => setReleasePaths([row.virtualPath!])} disabled={releaseBusy}>
                               {t('mappingReleaseAction')}
                             </Button>
                            ) : null}
                           </MappingRowActions> : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
            </MappingTable>
          )}
        </>
      )}

      <AutoRematchDialog
        open={autoRematchScope !== null}
        initialCandidatePaths={autoRematchScope?.initialCandidatePaths}
        targetPaths={autoRematchScope?.targetPaths ?? []}
        busy={autoRematchBusy}
        onApply={(candidatePaths, targetPaths, algorithms) => void applyAutoRematch(candidatePaths, targetPaths, algorithms)}
        onClose={() => !autoRematchBusy && setAutoRematchScope(null)}
      />
      <ResourcePickerDialog
        open={manualTargetPath !== null}
        title={t('manualRematchTitle')}
        selected={[]}
        selectable="inbox"
        onConfirm={(paths) => paths[0] && void applyManualRematch(paths[0])}
        onClose={() => !manualRematchBusy && setManualTargetPath(null)}
      />

      <FingerprintDialog
        open={fingerprintOpen}
        targets={fingerprintDialogTargets}
        busy={fingerprintBusy}
        error={fingerprintError}
        onCalculate={(virtualPaths, algorithms, forceOverwrite) => void runFingerprints(virtualPaths, algorithms, forceOverwrite)}
        onClose={() => {
          setFingerprintOpen(false);
          setFingerprintError(null);
        }}
      />
      <ConfirmDialog
        open={releasePaths !== null}
        title={t('mappingReleaseTitle')}
        message={t('mappingReleaseMessage', { count: releasePaths?.length ?? 0 })}
        confirmLabel={t('mappingReleaseConfirm')}
        busy={releaseBusy}
        onConfirm={() => void release()}
        onClose={() => !releaseBusy && setReleasePaths(null)}
      />
    </Box>
  );
}
