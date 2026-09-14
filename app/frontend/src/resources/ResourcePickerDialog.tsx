// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Resource picker dialog: pick one or several RFG virtual paths. Two
 * user-switchable views operate on the same filtered, identically ordered
 * page of entries and share one selection:
 *
 * - `thumbnails`: compact card grid. Present image resources render their
 *   cached thumbnail (except SVGs, which use their direct original route);
 *   unavailable and non-image files show a centred generic file icon in the
 *   preview frame (never filename text in the image area).
 * - `list`: a file-manager table — one selectable row per entry with a
 *   file-type icon, filename, location, kind, and classification state.
 *   No image thumbnails are loaded in this view.
 *
 * Both views support single and multiple selection of available entries with
 * the same confirm semantics, keyboard operation, search, and paging. A
 * pending selection materializes only when its containing record is saved.
 * Retained missing selections remain visible but cannot be toggled.
 */

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import { api, ApiError } from '../api/client';
import type { Airline, FlightRecord } from '../api/types';
import { rfg, type MappingEntry } from '../rfg/api';
import { EmptyState } from '../components/States';
import { useTranslation } from '../i18n';
import { ResourceImage } from './ResourceImage';
import {
  RESOURCE_PICKER_PAGE_SIZE,
  fileKind,
  filterResourceEntries,
  isImageResource,
  isUnclassified,
  leafName,
  parentFolder,
} from './resourcePicker';
import { resourceUsageCounts, resourceUsageIndex, usageForPath, usageRoleKey, type ResourceUse } from './resourceUsage';
import { scaled, useDialogScale } from '../utils/dialogScale';

type PickerView = 'thumbnails' | 'list';

/** Per-entry type icon for the list view (the thumbnail view uses the same
 *  generic file icon for non-images and unavailable entries). */
function TypeIcon({ path }: { path: string }) {
  if (isImageResource(path)) return <ImageOutlinedIcon fontSize="small" color="action" />;
  if (/\.pdf$/i.test(path)) return <PictureAsPdfOutlinedIcon fontSize="small" color="action" />;
  if (/\.(csv|json|log|md|txt)$/i.test(path)) return <ArticleOutlinedIcon fontSize="small" color="action" />;
  return <InsertDriveFileOutlinedIcon fontSize="small" color="action" />;
}

/** Mapping, source-availability, and usage state shared by both picker views. */
function ClassificationChip({ path, inUse, sourceMissing }: { path: string; inUse: boolean; sourceMissing: boolean }) {
  const { t } = useTranslation();
  if (sourceMissing) return <Chip size="small" color="error" variant="outlined" label={t('mappingStatusMissing')} />;
  return isUnclassified(path) ? (
    <Chip size="small" color="warning" variant="outlined" label={t('resourcePending')} />
  ) : (
    <Chip size="small" color={inUse ? 'primary' : 'default'} variant="outlined" label={t(inUse ? 'resourceMappedInUse' : 'resourceMapped')} />
  );
}

export function ResourcePickerDialog({ open, title, selected, multiple = false, imageOnly = false, allowedPaths, onConfirm, onClose }: {
  open: boolean; title: string; selected: string[]; multiple?: boolean; imageOnly?: boolean;
  /** Optional caller-owned subset, used when a workflow may consume only inbox files. */
  allowedPaths?: readonly string[];
  onConfirm: (paths: string[]) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialogScale = useDialogScale();
  const [entries, setEntries] = useState<MappingEntry[] | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [localPaths, setLocalPaths] = useState<ReadonlySet<string>>(new Set());
  const [flights, setFlights] = useState<FlightRecord[]>([]);
  const [airlines, setAirlines] = useState<Airline[]>([]);
  const [picked, setPicked] = useState(selected);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<PickerView>('thumbnails');
  const [ignoring, setIgnoring] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEntries(null);
    setPicked(selected);
    setQuery('');
    setError(null);
    setPage(1);
    void api.syncResources()
      .then(() => Promise.all([rfg.getMappingMeta(), api.getResourceCatalog(), api.listFlights(), api.getCatalogs()]))
      .then(([mapping, catalog, flightData, catalogs]) => {
        setEntries(mapping.document.entries);
        setEtag(mapping.etag);
        setLocalPaths(new Set(catalog.localFiles.map((file) => file.local_path)));
        const availableLocalPaths = new Set(catalog.localFiles.map((file) => file.local_path));
        setPicked((current) => current.filter((path) => {
          const entry = mapping.document.entries.find((candidate) => candidate.virtual_path === path);
          return entry !== undefined && !(path.startsWith('inbox/') && !availableLocalPaths.has(entry.local_path));
        }));
        setFlights(flightData.flights);
        setAirlines(catalogs.airlines);
      })
      .catch(() => setError(t('resourceLoadFailed')));
  }, [open, selected, t]);

  const visible = useMemo(() => {
    const filtered = filterResourceEntries(entries ?? [], imageOnly, query);
    // Sync removes these entries, but hide an inbox source that vanished in
    // the narrow window before refresh completes as an additional safeguard.
    const selectable = filtered.filter((entry) => !entry.virtual_path.startsWith('ignore/') && !(entry.virtual_path.startsWith('inbox/') && !localPaths.has(entry.local_path)));
    return allowedPaths ? selectable.filter((entry) => allowedPaths.includes(entry.virtual_path)) : selectable;
  }, [entries, imageOnly, query, allowedPaths, localPaths]);
  const usage = useMemo(() => resourceUsageIndex(flights, airlines), [flights, airlines]);
  const usageText = (path: string) => {
    const uses = usageForPath(usage, path);
    if (!uses.length) return t('resourceAvailable');
    return t('resourceUsageContext', resourceUsageCounts(uses));
  };
  const usageDetails = (uses: readonly ResourceUse[]) => uses.map((use, index) => {
    const detail = use.kind === 'flight'
      ? t('mappingUsageFlight', {
        flight: `${use.flight.airlineCode}${use.flight.flightNumber}`,
        date: use.flight.departureDate,
        role: t(usageRoleKey(use.role)),
      })
      : t('mappingUsageAirline', { code: use.airline.code, role: t(usageRoleKey(use.role)) });
    return <Box component="span" key={`${use.kind}-${index}`} sx={{ display: 'block' }}>{detail}</Box>;
  });
  const usageContext = (path: string, noWrap = false) => {
    const uses = usageForPath(usage, path);
    const label = <Typography variant="caption" color="text.secondary" noWrap={noWrap} sx={{ display: 'block' }}>{usageText(path)}</Typography>;
    return uses.length ? (
      <Tooltip title={<Box>{usageDetails(uses)}</Box>}>
        {label}
      </Tooltip>
    ) : label;
  };
  const pageCount = Math.max(1, Math.ceil(visible.length / RESOURCE_PICKER_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageFrom = visible.length === 0 ? 0 : (currentPage - 1) * RESOURCE_PICKER_PAGE_SIZE + 1;
  const pageTo = Math.min(currentPage * RESOURCE_PICKER_PAGE_SIZE, visible.length);
  const paged = useMemo(
    () => visible.slice((currentPage - 1) * RESOURCE_PICKER_PAGE_SIZE, currentPage * RESOURCE_PICKER_PAGE_SIZE),
    [visible, currentPage],
  );

  const sourceMissing = (entry: MappingEntry) => !localPaths.has(entry.local_path);
  const toggle = (path: string, unavailable = false) => {
    // Retain an already-selected missing path so an existing record can be
    // reviewed or left unchanged, but never add/remove unavailable mappings.
    if (unavailable) return;
    setPicked((previous) =>
      multiple
        ? previous.includes(path)
          ? previous.filter((p) => p !== path)
          : [...previous, path]
        : previous.includes(path)
          ? []
          : [path],
    );
  };
  const rowKeyDown = (event: KeyboardEvent<HTMLElement>, path: string, unavailable: boolean) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle(path, unavailable);
    }
  };
  const ignoredCandidate = !multiple && picked.length === 1 && picked[0].startsWith('inbox/') && entries?.some((entry) => entry.virtual_path === picked[0] && !sourceMissing(entry));
  const ignore = async () => {
    if (!ignoredCandidate || !picked[0]) return;
    setIgnoring(true);
    setError(null);
    try {
      const response = await api.ignoreResource({ ifMatch: etag, virtualPath: picked[0] });
      setEntries(response.mapping.entries);
      setEtag(response.etag);
      setLocalPaths(new Set(response.localFiles.map((file) => file.local_path)));
      setPicked([]);
    } catch (problem) {
      setError(problem instanceof ApiError && problem.httpStatus === 409 ? t('resourceIgnoreConflict') : t('resourceIgnoreFailed'));
    } finally { setIgnoring(false); }
  };

  const viewSwitch = (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={view}
      onChange={(_event, next: PickerView | null) => {
        if (next) setView(next);
      }}
      aria-label={t('resourceViewMode')}
    >
      <ToggleButton value="thumbnails" aria-label={t('resourceViewThumbnails')}>
        <Tooltip title={t('resourceViewThumbnails')}>
          <GridViewOutlinedIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
      <ToggleButton value="list" aria-label={t('resourceViewList')}>
        <Tooltip title={t('resourceViewList')}>
          <ViewListOutlinedIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
    </ToggleButtonGroup>
  );

  const thumbnailGrid = (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1.5 }}>
      {paged.map((entry) => {
        const active = picked.includes(entry.virtual_path);
        const image = isImageResource(entry.virtual_path);
        const inUse = usageForPath(usage, entry.virtual_path).length > 0;
        const unavailable = sourceMissing(entry);
        return (
          <Card key={entry.virtual_path} variant="outlined" sx={{ outline: active ? 2 : 0, outlineColor: 'primary.main', position: 'relative' }}>
            <CardActionArea disabled={unavailable} onClick={() => toggle(entry.virtual_path, unavailable)} sx={{ p: 1 }}>
              <Box sx={{ height: 108, display: 'grid', placeItems: 'center', color: 'text.secondary' }}>
                {image && !unavailable ? (
                  <ResourceImage resourcePath={entry.virtual_path} size={100} alt={leafName(entry.virtual_path)} />
                ) : (
                  <InsertDriveFileOutlinedIcon sx={{ fontSize: 44 }} />
                )}
              </Box>
              <Typography variant="caption" noWrap sx={{ display: 'block' }}>
                {entry.virtual_path}
              </Typography>
              <Box sx={{ mt: 0.5 }}><ClassificationChip path={entry.virtual_path} inUse={inUse} sourceMissing={unavailable} /></Box>
              {usageContext(entry.virtual_path, true)}
              {active ? <CheckCircleIcon color="primary" sx={{ position: 'absolute', right: 6, top: 6 }} /> : null}
            </CardActionArea>
          </Card>
        );
      })}
    </Box>
  );

  const listTable = (
    <TableContainer sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label={title}>
        <TableHead>
          <TableRow>
            {multiple ? <TableCell padding="checkbox" /> : null}
            <TableCell>{t('name')}</TableCell>
            <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>{t('resourceLocation')}</TableCell>
            <TableCell>{t('resourceKind')}</TableCell>
            <TableCell>{t('status')}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {paged.map((entry) => {
            const path = entry.virtual_path;
            const active = picked.includes(path);
            const inUse = usageForPath(usage, path).length > 0;
            const unavailable = sourceMissing(entry);
            return (
              <TableRow
                key={path}
                hover
                selected={active}
                role={multiple ? 'checkbox' : 'radio'}
                aria-checked={active}
                aria-disabled={unavailable || undefined}
                tabIndex={unavailable ? -1 : 0}
                onClick={() => toggle(path, unavailable)}
                onKeyDown={(event) => rowKeyDown(event, path, unavailable)}
                sx={{
                  cursor: unavailable ? 'not-allowed' : 'pointer',
                  opacity: unavailable ? 0.7 : 1,
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                }}
              >
                {multiple ? (
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={active}
                      size="small"
                      disabled={unavailable}
                      disableRipple
                      slotProps={{ input: { readOnly: true, tabIndex: -1, 'aria-hidden': true } }}
                    />
                  </TableCell>
                ) : null}
                <TableCell sx={{ maxWidth: 260 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                    <TypeIcon path={path} />
                    <Typography variant="body2" noWrap sx={{ fontWeight: active ? 650 : 400 }}>
                      {leafName(path)}
                    </Typography>
                  </Box>
                </TableCell>
                <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' }, maxWidth: 220 }}>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                    {parentFolder(path) || t('notAvailable')}
                  </Typography>
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Typography variant="caption" color="text.secondary">
                    {fileKind(path) || t('notAvailable')}
                  </Typography>
                </TableCell>
                <TableCell>
                  <ClassificationChip path={path} inUse={inUse} sourceMissing={unavailable} />
                  {usageContext(path)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth slotProps={{ paper: { sx: { width: scaled(900, dialogScale), maxWidth: '95vw', maxHeight: '90vh' } } }}>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mb: 2, flexWrap: 'wrap' }}>
          <TextField
            size="small"
            label={t('resourceSearch')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            sx={{ flex: '1 1 220px' }}
          />
          <Box sx={{ flexGrow: 1 }} />
          {viewSwitch}
        </Box>
        {error ? (
          <Alert severity="error">{error}</Alert>
        ) : entries === null ? (
          <Typography>{t('resourceLoading')}</Typography>
        ) : visible.length === 0 ? (
          <EmptyState title={t('noEntries')} />
        ) : (
          <>
            {view === 'thumbnails' ? thumbnailGrid : listTable}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1, mt: 2 }}>
              <Typography variant="caption" color="text.secondary">
                {t('pageIndicator', { from: pageFrom, to: pageTo, total: visible.length })}
              </Typography>
              {pageCount > 1 ? <Pagination size="small" count={pageCount} page={currentPage} onChange={(_event, value) => setPage(value)} /> : null}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        {!multiple ? <Box sx={{ mr: 'auto' }}><Button onClick={() => void ignore()} disabled={!ignoredCandidate || ignoring}>{ignoring ? t('resourceIgnoring') : t('resourceIgnore')}</Button></Box> : null}
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button variant="contained" disabled={!picked.length || ignoring} onClick={() => onConfirm(picked)}>
          {t('resourceSelect')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
