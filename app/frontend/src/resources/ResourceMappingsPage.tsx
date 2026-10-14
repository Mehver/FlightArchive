// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Review and directly manage the RFG catalog/mapping inventory. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
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
import { HASH_ALGORITHMS, type HashAlgorithm } from '../rfg/api';
import { useResourceMapping } from '../rfg/ResourceMappingProvider';
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
import { MarqueeCopyText } from './MarqueeCopyText';
import { useBusinessData } from '../domain/BusinessDataProvider';
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
};

type AutoRematchScope = {
  initialCandidatePaths: string[];
  targetPaths: string[];
};

type FirstSortField = 'fingerprints';
type SecondSortField = 'virtualPath' | 'localPath' | 'size';
type SortDirection = 'asc' | 'desc';

/** One source of truth for both searchable and rendered row sizes. */
export function sizeOf(row: MappingRow): number | null {
  return row.resource.sizeBytes;
}

export function ResourceMappingsPage() {
  const { t } = useTranslation();
  const { notify, reportFailure } = useAppState();
  const resources = useResourceMapping();
  const business = useBusinessData();
  const [filter, setFilter] = useState<MappingRowFilter | 'rebuild'>('all');
  const [search, setSearch] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const selectionAnchorRef = useRef<string | null>(null);
  const [firstSort, setFirstSort] = useState<{ field: FirstSortField; direction: SortDirection } | null>(null);
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
  const [releasePaths, setReleasePaths] = useState<string[] | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const releaseInFlight = useRef(false);
  const [unignoreBusy, setUnignoreBusy] = useState(false);
  const [ignoreBusy, setIgnoreBusy] = useState(false);
  const tRef = useRef(t);
  const reportFailureRef = useRef(reportFailure);
  tRef.current = t;
  reportFailureRef.current = reportFailure;

  const load = useCallback(async () => {
      try {
        await resources.refresh();
      } catch (error) {
         reportFailureRef.current(error, {
           fallback: tRef.current('mappingLoadFailed'), context: { action: tRef.current('mappingRefresh'), form: tRef.current('resourceMappings') },
           activity: { source: 'frontend-resources', kind: 'mapping', severity: 'error', state: 'failed', code: 'resource-mapping-failed', details: { operation: 'refresh' } },
         });
      }
    }, [resources.refresh]);

  const rows = useMemo(
    () => toMappingRows(resources.inventory),
    [resources.inventory],
  );
  const counts = useMemo(() => countMappingRows(rows), [rows]);
  const targets = useMemo(() => rematchTargets(rows), [rows]);
  const candidates = useMemo(() => rematchCandidates(rows), [rows]);
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (row: MappingRow) => {
      const fingerprint = fingerprintRowState(row);
      const fingerprintText = fingerprint.kind === 'stable' ? HASH_ALGORITHMS.map((algorithm) => ALGORITHM_LABEL[algorithm]).join(' ') : '';
      const size = sizeOf(row);
      const text = [t(KIND_LABEL[row.kind]), row.virtualPath, row.localPath, fingerprintText, typeof size === 'number' ? formatBytes(size, t) : t('notAvailable')].filter(Boolean).join(' ').toLowerCase();
      return !needle || text.includes(needle);
    };
    const filtered = rows.filter((row) => (filter === 'rebuild' ? row.kind === 'missing' || row.kind === 'inbox' : filter === 'all' || row.kind === filter) && matches(row));
    const firstValue = (row: MappingRow) => Number(HASH_ALGORITHMS.some((algorithm) => row.entry[algorithm]));
    const compareSecond = (left: MappingRow, right: MappingRow) => {
      const direction = secondSort.direction === 'asc' ? 1 : -1;
      if (secondSort.field === 'size') {
        const leftSize = sizeOf(left), rightSize = sizeOf(right);
        if (leftSize === null) return rightSize === null ? 0 : 1;
        if (rightSize === null) return -1;
        return direction * (leftSize - rightSize);
      }
      const leftPath = secondSort.field === 'virtualPath' ? left.virtualPath : left.localPath;
      const rightPath = secondSort.field === 'virtualPath' ? right.virtualPath : right.localPath;
      return direction * leftPath.localeCompare(rightPath);
    };
    return [...filtered].sort((left, right) => {
      if (firstSort) {
        const grouped = (firstSort.direction === 'asc' ? 1 : -1) * (firstValue(left) - firstValue(right));
        if (grouped) return grouped;
      }
      return compareSecond(left, right);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filter, firstSort, search, secondSort, t]);
  const selectablePaths = useMemo(() => new Set(rows.flatMap((row) => {
    const inCurrentFilter = filter === 'rebuild'
      ? row.kind === 'missing' || row.kind === 'inbox'
      : filter !== 'all' && row.kind === filter;
    if (!inCurrentFilter) return [];
    if (filter === 'all') return [];
    const allowed = filter === 'rebuild'
      ? row.kind === 'missing' || (row.kind === 'inbox' && row.resource.present)
      : filter === 'missing' ? row.kind === 'missing'
       : filter === 'inbox' ? row.resource.present
       : filter === 'ignored' ? true
      : filter === 'paired' ? row.resource.present
      : false;
    return allowed ? [row.virtualPath] : [];
  })), [rows, filter]);
  const visibleSelectablePaths = useMemo(
    () => visible.filter((row) => selectablePaths.has(row.virtualPath)).map((row) => row.virtualPath),
    [selectablePaths, visible],
  );
  useEffect(() => {
    // A refresh temporarily invalidates the view; only prune against complete data.
    if (resources.mapping === null) return;
    setSelectedPaths((selected) => selected.filter((path) => selectablePaths.has(path)));
  }, [selectablePaths, resources.mapping]);
  useEffect(() => { selectionAnchorRef.current = null; }, [filter, search, firstSort, secondSort]);

  const eligibleFingerprints = useMemo(() => fingerprintTargets(rows), [rows]);
  // Dialog targets resolve from the *latest* eligible set: after a reload the
  // reviewed selection may be gone (rematch/unbind), which the dialog shows
  // as stale instead of offering a rejected calculation.
  const fingerprintDialogTargets = useMemo(
    () => eligibleFingerprints.filter((target) => fingerprintPaths.includes(target.virtualPath)),
    [eligibleFingerprints, fingerprintPaths],
  );

  const applyAutoRematch = async (candidateInboxVirtualPaths: string[], targetVirtualPaths: string[], algorithms: AutoMatchAlgorithm[]) => {
    setAutoRematchBusy(true);
    try {
      const result = await resources.autoRematch(targetVirtualPaths, candidateInboxVirtualPaths, algorithms);
      notify(t('batchRematchResult', { applied: result.applied, ambiguous: result.ambiguous.length, unmatched: result.unmatched.length }), result.ambiguous.length || result.unmatched.length ? 'warning' : 'success', { action: t('batchRematchAction'), form: t('resourceMappings') });
      setAutoRematchScope(null);
    } catch (error) {
      const context = { action: t('batchRematchAction'), form: t('resourceMappings') };
       reportFailure(error, { fallback: t('batchRematchFailed'), context, activity: { source: 'frontend-resources', kind: 'mapping', severity: 'error', state: 'failed', code: 'resource-mapping-failed', details: { operation: 'auto-rematch' } } });
    } finally { setAutoRematchBusy(false); }
  };

  const applyManualRematch = async (candidateInboxVirtualPath: string) => {
    if (!manualTargetPath || manualRematchInFlight.current) return;
    manualRematchInFlight.current = true;
    const targetVirtualPath = manualTargetPath;
    setManualRematchBusy(true);
    const context = { action: t('manualRematchAction'), resource: targetVirtualPath, form: t('resourceMappings') };
    try {
      await resources.rematch([{ targetVirtualPath, candidateVirtualPath: candidateInboxVirtualPath }]);
      notify(t('manualRematchDone'), 'success', context);
      setManualTargetPath(null);
    } catch (error) {
       reportFailure(error, { fallback: t('manualRematchFailed'), context, activity: { source: 'frontend-resources', kind: 'mapping', severity: 'error', state: 'failed', code: 'resource-mapping-failed', details: { operation: 'manual-rematch', resource: targetVirtualPath } } });
    } finally {
      manualRematchInFlight.current = false;
      setManualRematchBusy(false);
    }
  };

  const ignore = async (paths: string[]) => {
    if (!paths.length) return;
    setIgnoreBusy(true);
    try {
      await resources.ignore(paths);
      setSelectedPaths([]);
    } catch (error) {
      const context = { action: t('resourceIgnore'), resource: paths.join(', '), form: t('resourceMappings') };
       reportFailure(error, { fallback: t('resourceIgnoreFailed'), context, activity: { source: 'frontend-resources', kind: 'mapping', severity: 'error', state: 'failed', code: 'resource-mapping-failed', details: { operation: 'ignore', resources: paths.join(', ') } } });
    } finally { setIgnoreBusy(false); }
  };

  const openFingerprints = (virtualPaths: string[]) => {
    setFingerprintPaths(virtualPaths);
    setFingerprintOpen(true);
  };

  const release = async () => {
    if (!releasePaths?.length || releaseInFlight.current) return;
    releaseInFlight.current = true;
    setReleaseBusy(true);
    try {
      await resources.release(releasePaths, () => {
        if (business.phase !== 'ready' || !business.data) throw new Error(t('mappingReleaseReferencesUnavailable'));
        if (business.hasResourceReferences(releasePaths)) throw new Error(t('mappingReleaseReferenced'));
      });
      notify(t('mappingReleaseDone', { count: releasePaths.length }), 'success', { action: t('mappingReleaseAction'), form: t('resourceMappings') });
      setReleasePaths(null);
    } catch (error) {
      const context = { action: t('mappingReleaseAction'), form: t('resourceMappings') };
      setReleasePaths(null);
      const fallback = error instanceof Error && (error.message === t('mappingReleaseReferenced') || error.message === t('mappingReleaseReferencesUnavailable'))
        ? error.message
        : t('mappingReleaseFailed');
       reportFailure(error, { fallback, context, activity: { source: 'frontend-resources', kind: 'mapping', severity: 'error', state: 'failed', code: 'resource-mapping-failed', details: { operation: 'release', resources: releasePaths.join(', ') } } });
    } finally {
      releaseInFlight.current = false;
      setReleaseBusy(false);
    }
  };

  const unignore = async (paths: string[]) => {
    if (!paths.length) return;
    setUnignoreBusy(true);
    try {
      await resources.unignore(paths);
      notify(t('mappingUnignoreDone', { count: paths.length }), 'success', { action: paths.length === 1 ? t('mappingUnignoreOneAction') : t('mappingUnignoreAction', { count: paths.length }), form: t('resourceMappings') });
      setSelectedPaths([]);
    } catch (error) {
      const context = { action: paths.length === 1 ? t('mappingUnignoreOneAction') : t('mappingUnignoreAction', { count: paths.length }), form: t('resourceMappings') };
       reportFailure(error, { fallback: t('mappingUnignoreFailed'), context, activity: { source: 'frontend-resources', kind: 'mapping', severity: 'error', state: 'failed', code: 'resource-mapping-failed', details: { operation: 'unignore', resources: paths.join(', ') } } });
    } finally {
      setUnignoreBusy(false);
    }
  };

  const toggleSelected = (path: string, shiftKey = false) => setSelectedPaths((selected) => {
    const anchor = selectionAnchorRef.current;
    const anchorIndex = anchor === null ? -1 : visibleSelectablePaths.indexOf(anchor);
    const targetIndex = visibleSelectablePaths.indexOf(path);
    if (shiftKey && anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const next = [...selected];
      for (const visiblePath of visibleSelectablePaths.slice(start, end + 1)) {
        if (!next.includes(visiblePath)) next.push(visiblePath);
      }
      return next;
    }
    selectionAnchorRef.current = path;
    return selected.includes(path) ? selected.filter((item) => item !== path) : [...selected, path];
  });

  const toggleAllSelected = () => {
    selectionAnchorRef.current = null;
    setSelectedPaths((old) => [...selectablePaths].every((path) => old.includes(path))
      ? old.filter((path) => !selectablePaths.has(path))
      : [...new Set([...old, ...selectablePaths])]);
  };

  const openSelectedAutoRematch = () => setAutoRematchScope({
    initialCandidatePaths: filter === 'rebuild'
      ? candidates.filter((item) => selectedPaths.includes(item.virtual_path)).map((item) => item.virtual_path)
      : [],
    targetPaths: targets.filter((item) => selectedPaths.includes(item.virtual_path)).map((item) => item.virtual_path),
  });


  const runFingerprints = async (virtualPaths: string[], algorithms: HashAlgorithm[], forceOverwrite: boolean) => {
    setFingerprintBusy(true);
    try {
      const targetsByPath = new Map(eligibleFingerprints.map((target) => [target.virtualPath, target]));
      const groups = new Map<string, string[]>();
      for (const path of virtualPaths) {
        const target = targetsByPath.get(path);
        const supported = target?.supported ?? algorithms;
        const feasible = algorithms.filter((algorithm) => supported.includes(algorithm) && (forceOverwrite || !target?.stored.includes(algorithm)));
        if (feasible.length) groups.set(feasible.join(','), [...(groups.get(feasible.join(',')) ?? []), path]);
      }
      for (const [key, paths] of groups) for (const chunk of chunkVirtualPaths(paths)) {
        const result = await resources.fingerprint(chunk, key.split(',') as HashAlgorithm[]);
        // A cancelled batch must stop the whole handler: continuing would start
        // the next group with a fresh session after the user already cancelled.
        if (result.status === 'cancelled') return;
        if (result.status === 'failed') throw new Error(`${result.failed} fingerprint calculation(s) failed`);
      }
      notify(t('fingerprintsCalculated'), 'success', { action: t('fingerprintCalculate'), resource: virtualPaths.join(', '), form: t('resourceMappings') });
      setFingerprintOpen(false);
    } catch (error) {
      const context = { action: t('fingerprintCalculate'), resource: virtualPaths.join(', '), form: t('resourceMappings') };
       reportFailure(error, { fallback: t('fingerprintsFailed'), context, activity: { source: 'frontend-resources', kind: 'fingerprint', severity: 'error', state: 'failed', code: 'resource-fingerprint-failed', details: { resources: virtualPaths.join(', ') } } });
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

      {resources.mapping === null ? (
        resources.error ? (
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
          </Stack>
          <Stack direction="row" sx={{ mb: 2, gap: 1, alignItems: 'center' }}>
            <Button size="small" onClick={() => void load()} disabled={resources.loading}>{t('mappingRefresh')}</Button>
            {resources.fingerprintProgress.status !== 'idle' ? (
              <Typography variant="caption" color="text.secondary">
                {`${resources.fingerprintProgress.completed}/${resources.fingerprintProgress.total} · ${resources.fingerprintProgress.status}`}
              </Typography>
            ) : null}
            {resources.fingerprintProgress.status === 'running' ? <Button size="small" onClick={resources.cancelFingerprint}>{t('cancel')}</Button> : null}
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
                 {filter !== 'all' ? <MappingHeaderCell padding="checkbox"><Checkbox size="small" checked={selectablePaths.size > 0 && [...selectablePaths].every((path) => selectedPaths.includes(path))} indeterminate={selectedPaths.some((path) => selectablePaths.has(path)) && ![...selectablePaths].every((path) => selectedPaths.includes(path))} disabled={selectablePaths.size === 0} onChange={toggleAllSelected} slotProps={{ input: { 'aria-label': t('batchRematchSelectVisible') } }} /></MappingHeaderCell> : null}
                 <MappingHeaderCell>{t('status')}</MappingHeaderCell>
                <MappingHeaderCell sortDimension="second" active={secondSort.field === 'virtualPath'} direction={secondSort.field === 'virtualPath' ? secondSort.direction : 'asc'} onLabelClick={() => selectSecondSort('virtualPath')} onDirectionClick={() => selectSecondSort('virtualPath')} directionAriaLabel={sortDirectionLabel(t('mappingVirtualPath'), secondSort.field === 'virtualPath' ? secondSort.direction : 'asc')} pathDisplay={{ mode: pathDisplay.virtualPath, onCycle: () => cyclePathDisplay('virtualPath'), ariaLabel: t('mappingPathDisplayMode', { column: t('mappingVirtualPath'), mode: pathDisplay.virtualPath + 1 }) }}>{t('mappingVirtualPath')}</MappingHeaderCell>
                <MappingHeaderCell sortDimension="second" active={secondSort.field === 'localPath'} direction={secondSort.field === 'localPath' ? secondSort.direction : 'asc'} onLabelClick={() => selectSecondSort('localPath')} onDirectionClick={() => selectSecondSort('localPath')} directionAriaLabel={sortDirectionLabel(t('mappingLocalPath'), secondSort.field === 'localPath' ? secondSort.direction : 'asc')} pathDisplay={{ mode: pathDisplay.localPath, onCycle: () => cyclePathDisplay('localPath'), ariaLabel: t('mappingPathDisplayMode', { column: t('mappingLocalPath'), mode: pathDisplay.localPath + 1 }) }}>{t('mappingLocalPath')}</MappingHeaderCell>
                 <MappingHeaderCell sortDimension="first" active={firstSort?.field === 'fingerprints'} direction={firstSort?.field === 'fingerprints' ? firstSort.direction : 'asc'} onLabelClick={() => selectFirstSortLabel('fingerprints')} onDirectionClick={() => selectFirstSortDirection('fingerprints')} directionAriaLabel={sortDirectionLabel(t('mappingFingerprints'), firstSort?.field === 'fingerprints' ? firstSort.direction : 'asc')}>{t('mappingFingerprints')}</MappingHeaderCell>
                <MappingHeaderCell sortDimension="second" active={secondSort.field === 'size'} direction={secondSort.field === 'size' ? secondSort.direction : 'asc'} onLabelClick={() => selectSecondSort('size')} onDirectionClick={() => selectSecondSort('size')} directionAriaLabel={sortDirectionLabel(t('size'), secondSort.field === 'size' ? secondSort.direction : 'asc')}>{t('size')}</MappingHeaderCell>
                <MappingHeaderCell align="right">{t('actions')}</MappingHeaderCell>
              </TableRow>
            }>
                  {visible.map((row) => {
                    const size = sizeOf(row);
                    const fingerprint = fingerprintRowState(row);
                     return (
                      <TableRow key={row.key} hover>
                          {filter !== 'all' ? <TableCell padding="checkbox">
                             {selectablePaths.has(row.virtualPath) ? (
                               <Checkbox
                                 size="small"
                                    slotProps={{ input: { 'aria-label': t(rowSelectionLabel, { path: row.virtualPath }) } }} checked={selectedPaths.includes(row.virtualPath)} onChange={(event) => toggleSelected(row.virtualPath, Boolean((event.nativeEvent as MouseEvent).shiftKey))} disabled={ignoreBusy || unignoreBusy || autoRematchBusy || fingerprintBusy}
                               />
                             ) : null}
                          </TableCell> : null}
                           <TableCell sx={{ whiteSpace: 'nowrap' }}><MappingStatusChip kind={row.kind} label={<SearchHighlight text={t(KIND_LABEL[row.kind])} query={search} />} /></TableCell>
                         <TableCell sx={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                               <Box sx={{ minWidth: 0, flex: '1 1 auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'caption.fontSize' }}>
                                 <MarqueeCopyText value={row.virtualPath} displayText={formatMappingPath(row.virtualPath, pathDisplay.virtualPath)} query={search} copiedLabel={t('mappingCopied')} ariaLabel={t('mappingCopyField', { field: t('mappingVirtualPath'), value: row.virtualPath })} />
                               </Box>
                            </Box>
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
                         <TableCell sx={{ maxWidth: 320 }}>
                          {fingerprint.kind === 'hidden' ? (
                            <Typography variant="caption" color="text.disabled">
                              {t('notAvailable')}
                            </Typography>
                           ) : (
                            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}>
                                 <HashPresenceChips entry={row.entry} localPath={row.localPath} highlightQuery={search} />
                            </Box>
                          )}
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                           <SearchHighlight text={size !== null ? formatBytes(size, t) : t('notAvailable')} query={search} />
                        </TableCell>
                         <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                           {filter !== 'all' ? <MappingRowActions>
                            {fingerprint.kind === 'stable' && fingerprint.calculable ? (
                             <Tooltip title={t('fingerprintActionTooltip')}>
                               <Button
                                 size="small"
                                 color="primary"
                                 variant="outlined"
                                 startIcon={<FingerprintIcon />}
                                 onClick={() => openFingerprints([row.virtualPath])}
                                disabled={fingerprintBusy}
                              >
                                {t('fingerprintAction')}
                              </Button>
                            </Tooltip>
                          ) : null}
                             {row.kind === 'missing' || row.kind === 'paired' ? (
                              <Button
                                size="small"
                                color="primary"
                                variant="outlined"
                                startIcon={<FindReplaceIcon />}
                                 onClick={() => setManualTargetPath(row.entry.virtual_path)}
                                disabled={manualRematchBusy}
                             >
                               {t('manualRematchAction')}
                             </Button>
                            ) : null}
                              {row.kind === 'inbox' && row.resource.present ? <Button size="small" color="warning" variant="outlined" onClick={() => void ignore([row.virtualPath])} disabled={ignoreBusy}>{t('resourceIgnore')}</Button> : null}
                              {row.kind === 'ignored' ? <Button size="small" color="primary" variant="outlined" onClick={() => void unignore([row.virtualPath])} disabled={unignoreBusy}>{t('mappingUnignoreOneAction')}</Button> : null}
                             {row.kind === 'paired' || row.kind === 'missing' ? (
                              <Button size="small" color="error" variant="outlined" onClick={() => setReleasePaths([row.virtualPath])} disabled={releaseBusy}>
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
        progress={resources.fingerprintProgress}
        onCancel={resources.cancelFingerprint}
        onCalculate={(virtualPaths, algorithms, forceOverwrite) => void runFingerprints(virtualPaths, algorithms, forceOverwrite)}
        onClose={() => {
          setFingerprintOpen(false);
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
