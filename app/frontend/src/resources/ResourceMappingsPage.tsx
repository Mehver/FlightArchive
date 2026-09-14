// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Review resource status and usage, rematch missing sources, calculate
 * business-resource fingerprints, or release unreferenced present objects back to Pending. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import FindReplaceIcon from '@mui/icons-material/FindReplace';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { api, ApiError } from '../api/client';
import type { Airline, FlightRecord, ResourceFingerprintResult, ResourceLocalFile } from '../api/types';
import { HASH_ALGORITHMS, rfg, type HashAlgorithm, type MappingEntry } from '../rfg/api';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useTranslation, type TranslationKey } from '../i18n';
import { useAppState } from '../state/AppState';
import { formatBytes } from '../utils/format';
import {
  buildMappingRows,
  countMappingRows,
  rematchCandidates,
  rematchTargets,
  type MappingRow,
  type MappingRowFilter,
  type MappingRowKind,
} from './mappingJoin';
import {
  chunkVirtualPaths,
  fingerprintRowState,
  fingerprintTargets,
} from './fingerprints';
import { FingerprintDialog, HashPresenceChips, type FingerprintDialogError } from './FingerprintDialog';
import { BatchRematchDialog, type BatchMatchAlgorithm } from './BatchRematchDialog';
import { ResourcePickerDialog } from './ResourcePickerDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { resourceUsageCounts, resourceUsageIndex, usageForPath, usageRoleKey, type ResourceUse } from './resourceUsage';

const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' } as const;

const KIND_LABEL: Record<MappingRowKind, TranslationKey> = {
  paired: 'mappingStatusMapped',
  inbox: 'mappingStatusInbox',
  missing: 'mappingStatusMissing',
  local_only: 'mappingStatusLocalOnly',
};

function statusChip(kind: MappingRowKind, label: string, unbound = false) {
  const color = kind === 'missing' ? 'error' : kind === 'inbox' || unbound ? 'warning' : kind === 'paired' ? 'success' : 'default';
  return <Chip size="small" variant="outlined" color={color} label={label} />;
}

export function ResourceMappingsPage() {
  const { t } = useTranslation();
  const { notify, showError } = useAppState();
  const [entries, setEntries] = useState<MappingEntry[] | null>(null);
  const [localFiles, setLocalFiles] = useState<ResourceLocalFile[] | null>(null);
  const [flights, setFlights] = useState<FlightRecord[] | null>(null);
  const [airlines, setAirlines] = useState<Airline[] | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<MappingRowFilter>('all');
  const [search, setSearch] = useState('');
  const [applying, setApplying] = useState(false);
  const [batchRematchOpen, setBatchRematchOpen] = useState(false);
  const [batchRematchBusy, setBatchRematchBusy] = useState(false);
  const [singleRematchTarget, setSingleRematchTarget] = useState<string | null>(null);
  const [fingerprintOpen, setFingerprintOpen] = useState(false);
  const [fingerprintBatch, setFingerprintBatch] = useState(false);
  const [fingerprintPaths, setFingerprintPaths] = useState<string[]>([]);
  const [fingerprintBusy, setFingerprintBusy] = useState(false);
  const [fingerprintError, setFingerprintError] = useState<FingerprintDialogError | null>(null);
  const [fingerprintResults, setFingerprintResults] = useState<ResourceFingerprintResult[] | null>(null);
  const [releasePaths, setReleasePaths] = useState<string[] | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const promptedForRelease = useRef(false);

  const load = useCallback(
    async (background = false) => {
      if (!background) {
        setLoading(true);
        setLoadError(false);
      }
      try {
        // Sync first so newly discovered local files appear as pending inbox entries.
        await api.syncResources();
        const [meta, catalog, flightData, catalogs] = await Promise.all([
          rfg.getMappingMeta(),
          api.getResourceCatalog(),
          api.listFlights(),
          api.getCatalogs(),
        ]);
        setEntries(meta.document.entries);
        setEtag(meta.etag);
        setLocalFiles(catalog.localFiles);
        setFlights(flightData.flights);
        setAirlines(catalogs.airlines);
        setLoadError(false);
      } catch (error) {
        if (background) showError(error, t('mappingLoadFailed'));
        else setLoadError(true);
      } finally {
        if (!background) setLoading(false);
      }
    },
    [showError, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(
    () => buildMappingRows((localFiles ?? []).map((file) => file.local_path), entries ?? []),
    [localFiles, entries],
  );
  const counts = useMemo(() => countMappingRows(rows), [rows]);
  const targets = useMemo(() => rematchTargets(rows), [rows]);
  const candidates = useMemo(() => rematchCandidates(rows), [rows]);
  const usage = useMemo(() => resourceUsageIndex(flights ?? [], airlines ?? []), [flights, airlines]);
  // Only unreferenced present object mappings can be released through the API
  // back to inbox. Missing rows deliberately remain rematch targets.
  const releaseCandidates = useMemo(
    () => rows.flatMap((row) => row.kind === 'paired' && row.virtualPath && usageForPath(usage, row.virtualPath).length === 0 ? [row.virtualPath] : []),
    [rows, usage],
  );

  useEffect(() => {
    if (!promptedForRelease.current && entries !== null && localFiles !== null && flights !== null && airlines !== null && releaseCandidates.length) {
      promptedForRelease.current = true;
      setReleasePaths(releaseCandidates);
    }
  }, [entries, localFiles, flights, airlines, releaseCandidates]);
  const sizes = useMemo(
    () => new Map((localFiles ?? []).map((file) => [file.local_path, file.size_bytes])),
    [localFiles],
  );
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (filter === 'all' || row.kind === filter) &&
        (!needle ||
          (row.virtualPath ?? '').toLowerCase().includes(needle) ||
          (row.localPath ?? '').toLowerCase().includes(needle)),
    );
  }, [rows, filter, search]);

  // Any persisted business record (flight or airline) makes an object eligible.
  const references = useMemo(() => new Map([...usage].map(([path, uses]) => [path, uses.length])), [usage]);
  const eligibleFingerprints = useMemo(() => fingerprintTargets(rows, references), [rows, references]);
  const incompleteFingerprints = useMemo(
    () => eligibleFingerprints.filter((target) => target.stored.length < HASH_ALGORITHMS.length),
    [eligibleFingerprints],
  );
  // Dialog targets resolve from the *latest* eligible set: after a reload the
  // reviewed selection may be gone (rematch/unbind), which the dialog shows
  // as stale instead of offering a rejected calculation.
  const fingerprintDialogTargets = useMemo(
    () =>
      fingerprintBatch
        ? eligibleFingerprints
        : eligibleFingerprints.filter((target) => fingerprintPaths.includes(target.virtualPath)),
    [fingerprintBatch, eligibleFingerprints, fingerprintPaths],
  );

  const applyRematch = async (targetVirtualPath: string, candidateInboxVirtualPath: string) => {
    setApplying(true);
    try {
      await api.createResourceRematches({
        ifMatch: etag,
        matches: [{ targetVirtualPath, candidateInboxVirtualPath }],
      });
      setSingleRematchTarget(null);
      notify(t('rematchApplied'));
      await load(true);
    } catch (error) {
      if (error instanceof ApiError && error.httpStatus === 409) {
        // Concurrency conflict: reload mapping/catalog/etag so the dialog
        // lists the latest state, then let the user review and retry.
        await load(true);
      } else {
        const detail =
          error instanceof ApiError && error.httpStatus > 0
            ? t('apiRequestFailed', { status: error.httpStatus })
            : null;
        showError(error, detail ? `${t('rematchFailed')} — ${detail}` : t('rematchFailed'));
      }
    } finally {
      setApplying(false);
    }
  };

  const applyBatchRematch = async (candidateInboxVirtualPaths: string[], algorithms: BatchMatchAlgorithm[]) => {
    setBatchRematchBusy(true);
    try {
      const result = await api.createResourceBatchRematches({ ifMatch: etag, candidateInboxVirtualPaths, algorithms });
      notify(t('batchRematchResult', { applied: result.applied, ambiguous: result.ambiguous.length, unmatched: result.unmatched.length }), result.ambiguous.length || result.unmatched.length ? 'warning' : 'success');
      setBatchRematchOpen(false);
      await load(true);
    } catch (error) {
      showError(error, error instanceof ApiError && error.httpStatus === 409 ? t('rematchConflict') : t('batchRematchFailed'));
      if (error instanceof ApiError && error.httpStatus === 409) await load(true);
    } finally { setBatchRematchBusy(false); }
  };

  const openFingerprints = (virtualPath: string | null) => {
    setFingerprintBatch(virtualPath === null);
    setFingerprintPaths(virtualPath === null ? [] : [virtualPath]);
    setFingerprintError(null);
    setFingerprintResults(null);
    setFingerprintOpen(true);
  };

  const release = async () => {
    if (!releasePaths?.length) return;
    setReleaseBusy(true);
    try {
      await api.releaseResources({ ifMatch: etag, virtualPaths: releasePaths });
      notify(t('mappingReleaseDone', { count: releasePaths.length }));
      setReleasePaths(null);
      await load(true);
    } catch (error) {
      setReleasePaths(null);
      showError(error, error instanceof ApiError && error.httpStatus === 409 ? t('mappingReleaseConflict') : t('mappingReleaseFailed'));
      if (error instanceof ApiError && error.httpStatus === 409) await load(true);
    } finally {
      setReleaseBusy(false);
    }
  };

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
      ? t('mappingUsageFlight', { flight: `${use.flight.airlineCode}${use.flight.flightNumber}`, date: use.flight.departureDate, role: t(usageRoleKey(use.role)) })
      : t('mappingUsageAirline', { code: use.airline.code, role: t(usageRoleKey(use.role)) }),
  ).join('\n');

  const runFingerprints = async (virtualPaths: string[], algorithms: HashAlgorithm[]) => {
    setFingerprintBusy(true);
    setFingerprintError(null);
    setFingerprintResults(null);
    try {
      const aggregated: ResourceFingerprintResult[] = [];
      // Forward the reviewed mapping ETag; the backend caps each request, so
      // larger batches run as sequential ETag-chained chunks.
      let currentEtag = etag;
      const targetsByPath = new Map(eligibleFingerprints.map((target) => [target.virtualPath, target]));
      const groups = new Map<string, string[]>();
      for (const path of virtualPaths) {
        const supported = targetsByPath.get(path)?.supported ?? algorithms;
        const feasible = algorithms.filter((algorithm) => supported.includes(algorithm));
        if (feasible.length) groups.set(feasible.join(','), [...(groups.get(feasible.join(',')) ?? []), path]);
      }
      for (const [key, paths] of groups) for (const chunk of chunkVirtualPaths(paths)) {
        const response = await api.calculateResourceFingerprints({
          ifMatch: currentEtag,
          virtualPaths: chunk,
          algorithms: key.split(',') as HashAlgorithm[],
        });
        aggregated.push(...response.results);
        currentEtag = response.etag;
      }
      setFingerprintResults(aggregated);
      const stored = aggregated.filter((result) => result.persisted).length;
      const failed = aggregated.filter((result) => result.status === 'failed').length;
      notify(t('fingerprintsSummary', { stored, failed }), failed > 0 ? 'warning' : 'success');
      // Refresh mapping/etag/catalog after persisted changes; an all-failed
      // or all-unchanged run leaves the mapping untouched server-side.
      if (stored > 0) await load(true);
    } catch (error) {
      if (error instanceof ApiError && error.httpStatus === 409) {
        // Concurrency conflict: clear the stale view and reload mapping,
        // catalog, flights and ETag so the user reviews the latest state.
        setFingerprintResults(null);
        setFingerprintError({ message: t('fingerprintConflict'), conflict: true });
        await load(true);
      } else {
        const detail =
          error instanceof ApiError && error.httpStatus > 0
            ? t('apiRequestFailed', { status: error.httpStatus })
            : null;
        setFingerprintError({
          message: detail ? `${t('fingerprintsFailed')} — ${detail}` : t('fingerprintsFailed'),
          conflict: false,
        });
      }
    } finally {
      setFingerprintBusy(false);
    }
  };

  const sizeOf = (row: MappingRow): number | null => {
    const fromCatalog = row.localPath ? sizes.get(row.localPath) : undefined;
    const size = fromCatalog ?? row.entry?.size_bytes;
    return typeof size === 'number' ? size : null;
  };

  const filterTabs: { value: MappingRowFilter; label: string; count: number }[] = [
    { value: 'all', label: t('mappingFilterAll'), count: rows.length },
    { value: 'missing', label: t('mappingStatusMissing'), count: counts.missing },
    { value: 'inbox', label: t('mappingStatusInbox'), count: counts.inbox },
    { value: 'paired', label: t('mappingStatusMapped'), count: counts.paired },
    ...(counts.local_only > 0
      ? [{ value: 'local_only' as MappingRowFilter, label: t('mappingStatusLocalOnly'), count: counts.local_only }]
      : []),
  ];

  return (
    <Box>
      <PageHeader
        title={t('resourceMappings')}
        actions={
          <>
            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={() => void load()}
              disabled={loading || applying || fingerprintBusy || releaseBusy}
            >
              {t('mappingRefresh')}
            </Button>
            <Button
              variant="outlined"
              onClick={() => setReleasePaths(releaseCandidates)}
              disabled={loading || applying || fingerprintBusy || releaseBusy || releaseCandidates.length === 0}
            >
              {t('mappingReleaseAll', { count: releaseCandidates.length })}
            </Button>
            <Tooltip title={incompleteFingerprints.length === 0 ? t('fingerprintAllNone') : ''}>
              <span>
                <Button
                  variant="outlined"
                  startIcon={<FingerprintIcon />}
                  onClick={() => openFingerprints(null)}
                  disabled={loading || applying || fingerprintBusy || incompleteFingerprints.length === 0}
                >
                  {t('fingerprintAllAction')}
                </Button>
              </span>
            </Tooltip>
            <Button
              variant="contained"
              startIcon={<FindReplaceIcon />}
              onClick={() => setBatchRematchOpen(true)}
              disabled={loading || applying || fingerprintBusy || targets.length === 0 || candidates.length === 0}
            >
              {t('batchRematchAction')}
            </Button>
          </>
        }
      />

      {entries === null || localFiles === null || flights === null || airlines === null ? (
        loadError ? (
          <ErrorState message={t('mappingLoadFailed')} onRetry={() => void load()} />
        ) : (
          <LoadingState label={t('mappingLoading')} />
        )
      ) : (
        <>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mb: 2 }}>
            <Chip
              variant="outlined"
              color={counts.missing > 0 ? 'error' : 'default'}
              label={t('mappingSummaryMissing', { count: counts.missing })}
            />
            <Chip
              variant="outlined"
              color={counts.inbox > 0 ? 'warning' : 'default'}
              label={t('mappingSummaryInbox', { count: counts.inbox })}
            />
            <Chip variant="outlined" label={t('mappingSummaryMapped', { count: counts.paired })} />
            {counts.local_only > 0 ? (
              <Chip variant="outlined" label={t('mappingSummaryLocalOnly', { count: counts.local_only })} />
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
              onChange={(_event, value: MappingRowFilter) => setFilter(value)}
              variant="scrollable"
              scrollButtons="auto"
              aria-label={t('mappingFilterAll')}
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
          </Box>

          {rows.length === 0 ? (
            <EmptyState title={t('mappingEmpty')} hint={t('mappingEmptyHint')} />
          ) : visible.length === 0 ? (
            <EmptyState title={t('noEntries')} />
          ) : (
            <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label={t('resourceMappings')}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('status')}</TableCell>
                    <TableCell>{t('mappingVirtualPath')}</TableCell>
                    <TableCell>{t('mappingLocalPath')}</TableCell>
                    <TableCell>{t('mappingUsage')}</TableCell>
                    <TableCell>{t('mappingFingerprints')}</TableCell>
                    <TableCell>{t('size')}</TableCell>
                    <TableCell align="right">{t('actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visible.map((row) => {
                    const size = sizeOf(row);
                    const fingerprint = fingerprintRowState(row, references);
                    const rowUsage = usageForPath(usage, row.virtualPath);
                    return (
                      <TableRow key={row.key} hover>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>{statusChip(row.kind, row.kind === 'paired' ? t(rowUsage.length ? 'mappingStatusInUse' : 'mappingStatusUnbound') : t(KIND_LABEL[row.kind]), row.kind === 'paired' && rowUsage.length === 0)}</TableCell>
                        <TableCell sx={{ maxWidth: 360 }}>
                          {row.virtualPath ? (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                              {row.kind === 'missing' ? (
                                <Tooltip title={t('rematchPreserved')}>
                                  <LockOutlinedIcon fontSize="small" color="primary" aria-hidden />
                                </Tooltip>
                              ) : null}
                              <Typography variant="caption" component="div" sx={MONO}>
                                {row.virtualPath}
                              </Typography>
                            </Box>
                          ) : (
                            <Typography variant="caption" color="text.disabled">
                              {t('notAvailable')}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell sx={{ maxWidth: 360 }}>
                          {row.kind === 'missing' ? (
                            <Tooltip title={row.localPath ?? ''}>
                              <Typography
                                variant="caption"
                                component="div"
                                color="error"
                                sx={{ ...MONO, textDecoration: 'line-through' }}
                              >
                                {row.localPath}
                              </Typography>
                            </Tooltip>
                          ) : row.localPath ? (
                            <Typography variant="caption" component="div" sx={MONO}>
                              {row.localPath}
                            </Typography>
                          ) : (
                            <Typography variant="caption" color="text.disabled">
                              {t('notAvailable')}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell sx={{ maxWidth: 250 }}>
                          {row.virtualPath ? (
                            <Tooltip title={usageDetails(rowUsage)} disableHoverListener={!rowUsage.length}>
                              <Chip size="small" color={rowUsage.length ? 'primary' : 'default'} variant="outlined" label={usageLabel(rowUsage)} />
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
                              <Chip size="small" variant="outlined" label={t('mappingUnreferenced')} />
                            </Tooltip>
                          ) : (
                            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}>
                              {row.entry ? <HashPresenceChips entry={row.entry} localPath={row.localPath ?? row.entry.local_path} /> : null}
                            </Box>
                          )}
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                          {size !== null ? formatBytes(size, t) : t('notAvailable')}
                        </TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          {fingerprint.kind === 'referenced' && fingerprint.calculable ? (
                            <Tooltip title={t('fingerprintActionTooltip')}>
                              <Button
                                size="small"
                                startIcon={<FingerprintIcon />}
                                onClick={() => row.virtualPath && openFingerprints(row.virtualPath)}
                                disabled={fingerprintBusy}
                              >
                                {t('fingerprintAction')}
                              </Button>
                            </Tooltip>
                          ) : null}
                          {row.kind === 'missing' && row.entry ? (
                            <Button
                              size="small"
                              onClick={() => setSingleRematchTarget(row.entry?.virtual_path ?? null)}
                              disabled={candidates.length === 0}
                            >
                              {t('rematchAction')}
                            </Button>
                          ) : null}
                          {row.kind === 'paired' && row.virtualPath && rowUsage.length === 0 ? (
                            <Button size="small" onClick={() => setReleasePaths([row.virtualPath!])} disabled={releaseBusy}>
                              {t('mappingReleaseAction')}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}

      <BatchRematchDialog open={batchRematchOpen} candidates={candidates} busy={batchRematchBusy} onApply={(paths, algorithms) => void applyBatchRematch(paths, algorithms)} onClose={() => !batchRematchBusy && setBatchRematchOpen(false)} />
      <ResourcePickerDialog
        open={singleRematchTarget !== null}
        title={t('rematchTitle')}
        selected={[]}
        allowedPaths={candidates.map((candidate) => candidate.virtual_path)}
        onConfirm={(paths) => {
          if (singleRematchTarget && paths[0]) void applyRematch(singleRematchTarget, paths[0]);
        }}
        onClose={() => !applying && setSingleRematchTarget(null)}
      />

      <FingerprintDialog
        open={fingerprintOpen}
        batch={fingerprintBatch}
        targets={fingerprintDialogTargets}
        busy={fingerprintBusy}
        error={fingerprintError}
        results={fingerprintResults}
        onCalculate={(virtualPaths, algorithms) => void runFingerprints(virtualPaths, algorithms)}
        onClose={() => {
          setFingerprintOpen(false);
          setFingerprintError(null);
          setFingerprintResults(null);
        }}
      />
      <ConfirmDialog
        open={releasePaths !== null}
        title={t('mappingReleaseTitle')}
        message={t('mappingReleaseMessage', { count: releasePaths?.length ?? 0 })}
        confirmLabel={t('mappingReleaseConfirm')}
        onConfirm={() => void release()}
        onClose={() => !releaseBusy && setReleasePaths(null)}
      />
    </Box>
  );
}
