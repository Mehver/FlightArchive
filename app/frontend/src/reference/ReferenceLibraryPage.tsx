// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Flight reference: human-facing maintenance of the independent reference
 * metadata (airlines, airports, aircraft types) that enriches flight
 * records. Direct flight codes remain valid without a catalog entry, so this
 * page also exposes read-only derived rows until an explicit edit upserts them.
 * Resource internals stay under the advanced tools; this page presents the
 * catalogs as a calm, product-facing library.
 *
 * Rows support single edit/delete plus checkbox multi-selection with a
 * select-all-visible control and one confirmed batch deletion (including
 * the standard forced-delete flow for referenced entries).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  IconButton,
  Paper,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Tabs,
  TextField,
  Tooltip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import { api, ApiError } from '../api/client';
import type { AircraftType, Airline, Airport, FlightRecord } from '../api/types';
import { useAppState } from '../state/AppState';
import { PageHeader } from '../components/PageHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState, LoadingState } from '../components/States';
import { displayFlightNumber, displayName, UNLISTED_REFERENCE_NOTE } from '../utils/format';
import { useTranslation, type TranslationKey } from '../i18n';
import { CatalogEntryDialog, catalogEntryKey, type CatalogEntry, type CatalogKind } from './CatalogEntryDialog';
import { isAircraftTypeIcao, isAirlineCode, isAirportCode } from '../flights/flightFormat';
import { FlightDialog } from '../flights/FlightDialog';
import { hexToCss } from '../theme/colors';

type LibraryKind = CatalogKind | 'flights';
type SortDirection = 'asc' | 'desc';
type SortState = { key: string; direction: SortDirection } | null;

const KIND_LABEL: Record<CatalogKind, TranslationKey> = {
  airlines: 'airlines',
  airports: 'airports',
  'aircraft-types': 'aircraftTypes',
};

interface CatalogRow {
  entry: CatalogEntry;
  /** Flight-derived rows are deliberately never persisted until their edit is saved. */
  derived: boolean;
}

function unlistedEntry(kind: CatalogKind, code: string): CatalogEntry {
  if (kind === 'airlines') {
    return { code, icao: '', nameZh: '', nameEn: '', alliance: null, horizontalLogoResourcePath: null, horizontalDarkLogoResourcePath: null, symbolLogoResourcePath: null, brandColors: { primary: null, contrast: null } };
  }
  if (kind === 'airports') {
    return { code, icao: '', nameZh: '', nameEn: '', cityZh: '', cityEn: '', countryZh: '', countryEn: '', terminals: [] };
  }
  return { icao: code, iata: '', manufacturer: null, displayName: '' };
}

function isEmptySortValue(value: string | number | null | undefined): boolean {
  return value === null || value === undefined || value === '';
}

/** Keep blank values at the end in both directions, then preserve source order for ties. */
function stableSort<T>(items: readonly T[], compare: (left: T, right: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => compare(left.item, right.item) || left.index - right.index)
    .map(({ item }) => item);
}

export function stringSuggestions(values: readonly (string | null)[], collator: Intl.Collator): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
    .sort(collator.compare);
}

export function ReferenceLibraryPage() {
  const { t, language } = useTranslation();
  const { catalogs, refreshAll, notify, showError } = useAppState();
  const [activeTab, setActiveTab] = useState<LibraryKind>('flights');
  const kind: CatalogKind = activeTab === 'flights' ? 'airlines' : activeTab;
  const [query, setQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CatalogRow | null>(null);
  const [deleting, setDeleting] = useState<CatalogEntry | null>(null);
  const [deleteForce, setDeleteForce] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDeleteForce, setBulkDeleteForce] = useState(false);
  // Flight references are deliberately loaded separately from the catalogs:
  // an unavailable count must not make catalog maintenance unavailable.
  const [flights, setFlights] = useState<FlightRecord[]>([]);
  const [flightsLoading, setFlightsLoading] = useState(true);
  const [flightDialogOpen, setFlightDialogOpen] = useState(false);
  const [editingFlight, setEditingFlight] = useState<FlightRecord | null>(null);
  const [savingFlight, setSavingFlight] = useState(false);
  const [deletingFlight, setDeletingFlight] = useState<FlightRecord | null>(null);
  const [bulkDeletingFlights, setBulkDeletingFlights] = useState(false);
  const [sorts, setSorts] = useState<Record<LibraryKind, SortState>>({
    flights: { key: 'date', direction: 'desc' },
    airlines: null,
    airports: null,
    'aircraft-types': null,
  });
  const collator = useMemo(() => new Intl.Collator(language, { numeric: true, sensitivity: 'base' }), [language]);
  const allianceSuggestions = useMemo(
    () => stringSuggestions((catalogs?.airlines ?? []).map((airline) => airline.alliance), collator),
    [catalogs, collator],
  );
  const manufacturerSuggestions = useMemo(
    () => stringSuggestions((catalogs?.aircraftTypes ?? []).map((aircraft) => aircraft.manufacturer), collator),
    [catalogs, collator],
  );

  const requestSort = (key: string) => {
    setSorts((current) => {
      const active = current[activeTab];
      return {
        ...current,
        [activeTab]: active?.key === key
          ? { key, direction: active.direction === 'asc' ? 'desc' : 'asc' }
          : { key, direction: 'asc' },
      };
    });
  };

  const compareSortValues = (left: string | number | null | undefined, right: string | number | null | undefined, direction: SortDirection) => {
    const leftEmpty = isEmptySortValue(left);
    const rightEmpty = isEmptySortValue(right);
    if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
    const result = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : collator.compare(String(left), String(right));
    return direction === 'asc' ? result : -result;
  };

  const fetchFlights = useCallback(async () => {
    setFlightsLoading(true);
    try {
      const result = await api.listFlights();
      setFlights(result.flights);
    } catch (error) {
      showError(error, t('failedToLoadFlights'));
    } finally {
      setFlightsLoading(false);
    }
  }, [showError, t]);

  useEffect(() => {
    void fetchFlights();
  }, [fetchFlights]);

  const entries: CatalogEntry[] = useMemo(() => {
    if (!catalogs) return [];
    if (kind === 'airlines') return catalogs.airlines;
    if (kind === 'airports') return catalogs.airports;
    return catalogs.aircraftTypes;
  }, [catalogs, kind]);

  const rows = useMemo<CatalogRow[]>(() => {
    const persistedKeys = new Set(entries.map((entry) => catalogEntryKey(kind, entry)));
    const unlistedCodes = new Set<string>();
    {
      for (const flight of flights) {
        if (kind === 'airlines' && isAirlineCode(flight.airlineCode)) unlistedCodes.add(flight.airlineCode);
        if (kind === 'airports') {
          if (isAirportCode(flight.departureAirport)) unlistedCodes.add(flight.departureAirport);
          if (isAirportCode(flight.arrivalAirport)) unlistedCodes.add(flight.arrivalAirport);
        }
        if (kind === 'aircraft-types' && flight.aircraftTypeIcao !== null && isAircraftTypeIcao(flight.aircraftTypeIcao)) unlistedCodes.add(flight.aircraftTypeIcao);
      }
    }
    const derived = [...unlistedCodes]
      .filter((code) => !persistedKeys.has(code))
      .sort((left, right) => left.localeCompare(right))
      .map((code) => ({ entry: unlistedEntry(kind, code), derived: true }));
    return [...derived, ...entries.map((entry) => ({ entry, derived: false }))];
  }, [entries, flights, kind]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(({ entry }) => {
      const haystack =
        kind === 'aircraft-types'
          ? `${(entry as AircraftType).icao} ${(entry as AircraftType).iata} ${(entry as AircraftType).displayName} ${(entry as AircraftType).manufacturer ?? ''}`
          : kind === 'airlines'
            ? `${(entry as Airline).code} ${(entry as Airline).icao} ${(entry as Airline).nameZh} ${(entry as Airline).nameEn} ${(entry as Airline).alliance ?? ''}`
            : `${(entry as Airport).code} ${(entry as Airport).icao} ${(entry as Airport).nameZh} ${(entry as Airport).nameEn} ${(entry as Airport).cityZh} ${(entry as Airport).cityEn} ${(entry as Airport).countryZh} ${(entry as Airport).countryEn}`;
      return haystack.toLowerCase().includes(q);
    });
  }, [rows, query, kind]);

  const flightReferenceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const increment = (key: string | null) => {
      if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
    };

    for (const flight of flights) {
      if (kind === 'airlines') {
        increment(flight.airlineCode);
      } else if (kind === 'airports') {
        // A flight departing from and arriving at the same airport has one
        // airport reference, matching the backend's delete semantics.
        increment(flight.departureAirport);
        if (flight.arrivalAirport !== flight.departureAirport) increment(flight.arrivalAirport);
      } else {
        increment(flight.aircraftTypeIcao);
      }
    }
    return counts;
  }, [flights, kind]);

  const referenceCount = (key: string) => flightReferenceCounts.get(key) ?? 0;

  const filteredFlights = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flights;
    return flights.filter((flight) => {
      const airline = catalogs?.airlines.find((entry) => entry.code === flight.airlineCode);
      const airlineName = airline ? `${airline.nameZh} ${airline.nameEn}` : '';
      return `${displayFlightNumber(flight.airlineCode, flight.flightNumber)} ${flight.departureDate} ${flight.departureAirport} ${flight.arrivalAirport} ${airlineName}`
        .toLowerCase()
        .includes(q);
    });
  }, [catalogs, flights, query]);

  const sortedFlights = useMemo(() => {
    const sort = sorts.flights;
    if (!sort) return filteredFlights;
    return stableSort(filteredFlights, (left, right) => {
      const leftAirline = catalogs?.airlines.find((entry) => entry.code === left.airlineCode);
      const rightAirline = catalogs?.airlines.find((entry) => entry.code === right.airlineCode);
      switch (sort.key) {
        case 'flightNumber':
          return compareSortValues(displayFlightNumber(left.airlineCode, left.flightNumber), displayFlightNumber(right.airlineCode, right.flightNumber), sort.direction);
        case 'date':
          return compareSortValues(`${left.departureDate} ${left.departureTime ?? ''}`, `${right.departureDate} ${right.departureTime ?? ''}`, sort.direction);
        case 'route':
          return compareSortValues(`${left.departureAirport} ${left.arrivalAirport}`, `${right.departureAirport} ${right.arrivalAirport}`, sort.direction);
        case 'airline':
          return compareSortValues(
            leftAirline ? displayName(leftAirline.nameZh, leftAirline.nameEn, left.airlineCode) : left.airlineCode,
            rightAirline ? displayName(rightAirline.nameZh, rightAirline.nameEn, right.airlineCode) : right.airlineCode,
            sort.direction,
          );
        default:
          return 0;
      }
    });
  }, [catalogs, collator, filteredFlights, sorts.flights]);

  const sortedCatalogRows = useMemo(() => {
    const sort = sorts[activeTab];
    if (activeTab === 'flights' || !sort) return filtered;
    return stableSort(filtered, (left, right) => {
      const leftEntry = left.entry;
      const rightEntry = right.entry;
      const catalogName = (row: CatalogRow) => {
        const entry = row.entry as Airline | Airport;
        return row.derived ? '' : displayName(entry.nameZh, entry.nameEn, '');
      };
      if (kind === 'aircraft-types') {
        const leftAircraft = leftEntry as AircraftType;
        const rightAircraft = rightEntry as AircraftType;
        const values: Record<string, [string | number, string | number]> = {
          icao: [leftAircraft.icao, rightAircraft.icao],
          iata: [leftAircraft.iata, rightAircraft.iata],
          displayName: [left.derived ? '' : leftAircraft.displayName, right.derived ? '' : rightAircraft.displayName],
          manufacturer: [left.derived ? '' : leftAircraft.manufacturer ?? '', right.derived ? '' : rightAircraft.manufacturer ?? ''],
          references: [referenceCount(leftAircraft.icao), referenceCount(rightAircraft.icao)],
        };
        const value = values[sort.key];
        return value ? compareSortValues(value[0], value[1], sort.direction) : 0;
      }
      if (kind === 'airlines') {
        const leftAirline = leftEntry as Airline;
        const rightAirline = rightEntry as Airline;
        const values: Record<string, [string | number, string | number]> = {
          code: [leftAirline.code, rightAirline.code],
          name: [catalogName(left), catalogName(right)],
          alliance: [left.derived ? '' : leftAirline.alliance ?? '', right.derived ? '' : rightAirline.alliance ?? ''],
          references: [referenceCount(leftAirline.code), referenceCount(rightAirline.code)],
        };
        const value = values[sort.key];
        return value ? compareSortValues(value[0], value[1], sort.direction) : 0;
      }
      const leftAirport = leftEntry as Airport;
      const rightAirport = rightEntry as Airport;
      const values: Record<string, [string | number, string | number]> = {
        code: [leftAirport.code, rightAirport.code],
        name: [catalogName(left), catalogName(right)],
        city: [left.derived ? '' : displayName(leftAirport.cityZh, leftAirport.cityEn, ''), right.derived ? '' : displayName(rightAirport.cityZh, rightAirport.cityEn, '')],
        country: [left.derived ? '' : displayName(leftAirport.countryZh, leftAirport.countryEn, ''), right.derived ? '' : displayName(rightAirport.countryZh, rightAirport.countryEn, '')],
        terminals: [left.derived ? '' : leftAirport.terminals.join(', '), right.derived ? '' : rightAirport.terminals.join(', ')],
        references: [referenceCount(leftAirport.code), referenceCount(rightAirport.code)],
      };
      const value = values[sort.key];
      return value ? compareSortValues(value[0], value[1], sort.direction) : 0;
    });
  }, [activeTab, collator, filtered, kind, sorts, flightReferenceCounts]);

  // Selection is keyed by catalog key and never outlives the entries it
  // refers to: kind switches, reloads and successful deletions all prune it.
  useEffect(() => {
    const valid = activeTab === 'flights'
      ? new Set(flights.map((flight) => flight.id))
      : new Set(entries.map((entry) => catalogEntryKey(kind, entry)));
    setSelected((prev) => {
      if ([...prev].every((key) => valid.has(key))) return prev;
      return new Set([...prev].filter((key) => valid.has(key)));
    });
  }, [activeTab, entries, flights, kind]);

  const visibleKeys = useMemo(
    () => activeTab === 'flights'
      ? filteredFlights.map((flight) => flight.id)
      : filtered.filter((row) => !row.derived).map(({ entry }) => catalogEntryKey(kind, entry)),
    [activeTab, filtered, filteredFlights, kind],
  );
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((key) => selected.has(key));
  const someVisibleSelected = visibleKeys.some((key) => selected.has(key));

  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const key of visibleKeys) next.delete(key);
      else for (const key of visibleKeys) next.add(key);
      return next;
    });
  };

  const saveEntry = async (entry: Record<string, unknown>) => {
    setSaving(true);
    try {
      if (editing) {
        await api.updateCatalogEntry(kind, catalogEntryKey(kind, editing.entry), entry);
        notify(t(editing.derived ? 'catalogEntryAdded' : 'catalogEntryUpdated'));
      } else {
        await api.createCatalogEntry(kind, entry);
        notify(t('catalogEntryAdded'));
      }
      setDialogOpen(false);
      setEditing(null);
      await refreshAll();
    } catch (error) {
      showError(error, t('couldNotSaveCatalog'));
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (force = false) => {
    if (!deleting) return;
    try {
      await api.deleteCatalogEntry(kind, catalogEntryKey(kind, deleting), force);
      notify(t('catalogEntryDeleted', { key: catalogEntryKey(kind, deleting) }));
      setDeleting(null);
      setDeleteForce(false);
      await refreshAll();
    } catch (error) {
      if (error instanceof ApiError && error.httpStatus === 409 && !force) {
        setDeleteForce(true);
      } else {
        showError(error, t('couldNotDeleteCatalog'));
      }
    }
  };

  // Batch deletion is never optimistic: the table only changes after the
  // server confirms, and a 409 switches the same dialog to the forced
  // confirmation exactly like the single-row flow.
  const deleteSelectedEntries = async (force = false) => {
    const keys = [...selected];
    if (keys.length === 0) return;
    try {
      const result = await api.deleteCatalogEntries(kind, keys, force);
      notify(t('catalogEntriesDeleted', { count: result.deleted.length }));
      setSelected(new Set());
      setBulkDeleting(false);
      setBulkDeleteForce(false);
      await refreshAll();
    } catch (error) {
      if (error instanceof ApiError && error.httpStatus === 409 && !force) {
        setBulkDeleteForce(true);
      } else {
        showError(error, t('couldNotDeleteCatalog'));
      }
    }
  };

  const saveFlight = async (payload: Partial<FlightRecord>) => {
    setSavingFlight(true);
    try {
      if (editingFlight) {
        const updated = await api.updateFlight(editingFlight.id, payload);
        notify(t('flightUpdated'));
        setEditingFlight(updated.flight);
        setFlights((current) => current.map((f) => f.id === updated.flight.id ? updated.flight : f));
      } else {
        const created = await api.createFlight(payload);
        notify(t('flightAdded'));
        setEditingFlight(created.flight);
        setFlights((current) => [created.flight, ...current]);
      }
      await fetchFlights();
    } catch (error) {
      showError(error, t('couldNotSaveFlight'));
    } finally {
      setSavingFlight(false);
    }
  };

  const deleteOneFlight = async () => {
    if (!deletingFlight) return;
    try {
      await api.deleteFlight(deletingFlight.id);
      notify(t('flightDeleted', { flightNumber: displayFlightNumber(deletingFlight.airlineCode, deletingFlight.flightNumber) }));
      setDeletingFlight(null);
      await fetchFlights();
    } catch (error) {
      showError(error, t('couldNotDeleteFlight'));
    }
  };

  const deleteSelectedFlights = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      let deletedCount = 0;
      for (const id of ids) {
        await api.deleteFlight(id);
        deletedCount++;
      }
      notify(t('flightsDeleted', { count: deletedCount }));
      setSelected(new Set());
      await fetchFlights();
    } catch (error) {
      await fetchFlights();
      showError(error, t('couldNotDeleteFlight'));
    } finally {
      setBulkDeletingFlights(false);
    }
  };

  const selectionCell = (key: string) => (
    <TableCell padding="checkbox">
      <Checkbox
        size="small"
        checked={selected.has(key)}
        onChange={() => toggleSelected(key)}
        slotProps={{ input: { 'aria-label': t('selectCatalogEntry', { key }) } }}
      />
    </TableCell>
  );

  const sortableHeader = (key: string, label: string, align: 'left' | 'right' | 'center' = 'left') => {
    const sort = sorts[activeTab];
    const active = sort?.key === key;
    const direction = active ? sort.direction : 'asc';
    const nextDirection = active && direction === 'asc' ? 'desc' : 'asc';
    return (
      <TableCell align={align} sortDirection={active ? direction : false}>
        <TableSortLabel
          active={active}
          direction={direction}
          onClick={() => requestSort(key)}
          aria-label={t('sortBy', { field: label, direction: t(nextDirection === 'asc' ? 'sortAscending' : 'sortDescending') })}
        >
          {label}
        </TableSortLabel>
      </TableCell>
    );
  };

  const rowActions = (row: CatalogRow) => (
    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
      <Tooltip title={t('edit')}>
        <IconButton
          size="small"
          aria-label={t('editCatalogEntry', { kind: t(KIND_LABEL[kind]) })}
          onClick={() => {
            setEditing(row);
            setDialogOpen(true);
          }}
        >
          <EditIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {!row.derived ? <Tooltip title={t('delete')}>
        <IconButton size="small" aria-label={t('deleteCatalogEntry')} onClick={() => setDeleting(row.entry)}>
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Tooltip> : null}
    </TableCell>
  );

  return (
    <Box>
      <PageHeader
        title={t('flightReference')}
        subtitle={`${t('flightReferenceSubtitle')} · ${t('referenceCount', { count: activeTab === 'flights' ? filteredFlights.length : filtered.length })}`}
        actions={
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              if (activeTab === 'flights') {
                setEditingFlight(null);
                setFlightDialogOpen(true);
              } else {
                setEditing(null);
                setDialogOpen(true);
              }
            }}
          >
            {activeTab === 'flights' ? t('addFlight') : t('addCatalogEntry', { kind: t(KIND_LABEL[kind]) })}
          </Button>
        }
      />

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
        <Tabs
          value={activeTab}
          onChange={(_e, value: LibraryKind) => {
            setActiveTab(value);
            setQuery('');
            setSelected(new Set());
          }}
          aria-label={t('flightReference')}
          sx={{ flex: '1 1 auto', minHeight: 40 }}
        >
          <Tab value="flights" label={t('flights')} sx={{ minHeight: 40 }} />
          <Tab value="airlines" label={t('airlines')} sx={{ minHeight: 40 }} />
          <Tab value="airports" label={t('airports')} sx={{ minHeight: 40 }} />
          <Tab value="aircraft-types" label={t('aircraftTypes')} sx={{ minHeight: 40 }} />
        </Tabs>
        <TextField
          size="small"
          label={t('search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 200, flex: '0 1 260px' }}
          slotProps={{ htmlInput: { 'aria-label': t('searchReference') } }}
        />
        {selected.size > 0 ? (
          <Button
            color="error"
            variant="outlined"
            startIcon={<DeleteIcon />}
            onClick={() => {
              if (activeTab === 'flights') {
                setBulkDeletingFlights(true);
              } else {
                setBulkDeleteForce(false);
                setBulkDeleting(true);
              }
            }}
          >
            {activeTab === 'flights'
              ? t('deleteSelectedFlights', { count: selected.size })
              : t('deleteSelectedCatalogEntries', { count: selected.size })}
          </Button>
        ) : null}
      </Box>

      {activeTab === 'flights' ? (
        flightsLoading ? (
          <LoadingState label={t('loadingFlights')} />
        ) : filteredFlights.length === 0 ? (
          <EmptyState title={t('noFlights')} hint={t('noFlightsHint')} />
        ) : (
          <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label={t('flights')}>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={allVisibleSelected}
                      indeterminate={!allVisibleSelected && someVisibleSelected}
                      onChange={toggleAllVisible}
                      slotProps={{ input: { 'aria-label': t('selectAllVisible') } }}
                    />
                  </TableCell>
                  {sortableHeader('flightNumber', t('flightNumber'))}
                  {sortableHeader('date', t('date'))}
                  {sortableHeader('route', t('route'))}
                  {sortableHeader('airline', t('airline'))}
                  <TableCell align="right">{t('actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedFlights.map((flight) => {
                  const airline = catalogs?.airlines.find((entry) => entry.code === flight.airlineCode);
                  const airlineName = airline
                    ? displayName(airline.nameZh, airline.nameEn, flight.airlineCode)
                    : flight.airlineCode;
                  const flightNumber = displayFlightNumber(flight.airlineCode, flight.flightNumber);
                  return (
                    <TableRow key={flight.id} hover selected={selected.has(flight.id)}>
                      {selectionCell(flight.id)}
                      <TableCell sx={{ fontWeight: 650, whiteSpace: 'nowrap' }}>{flightNumber}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{flight.departureDate}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{flight.departureAirport} → {flight.arrivalAirport}</TableCell>
                      <TableCell>{airlineName}</TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        <Tooltip title={t('edit')}>
                          <IconButton size="small" aria-label={t('editFlight')} onClick={() => {
                            setEditingFlight(flight);
                            setFlightDialogOpen(true);
                          }}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={t('delete')}>
                          <IconButton size="small" aria-label={t('deleteFlight')} onClick={() => setDeletingFlight(flight)}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )
      ) : catalogs === null ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <EmptyState title={t('libraryEmpty')} />
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label={t(KIND_LABEL[kind])}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    checked={allVisibleSelected}
                    indeterminate={!allVisibleSelected && someVisibleSelected}
                    onChange={toggleAllVisible}
                    slotProps={{ input: { 'aria-label': t('selectAllVisible') } }}
                  />
                </TableCell>
                {kind === 'aircraft-types' ? (
                  <>
                    {sortableHeader('icao', t('icaoCode'))}
                    {sortableHeader('iata', t('iataCode'))}
                    {sortableHeader('displayName', t('displayName'))}
                    {sortableHeader('manufacturer', t('manufacturer'))}
                  </>
                ) : (
                  <>
                    {sortableHeader('code', t('code'))}
                    {sortableHeader('name', t('name'))}
                    {kind === 'airlines' ? sortableHeader('alliance', t('alliance')) : null}
                    {kind === 'airlines' ? <TableCell>{t('airlineLogos')}</TableCell> : null}
                    {kind === 'airlines' ? <TableCell align="center">{t('primaryBrandColor')}</TableCell> : null}
                    {kind === 'airlines' ? <TableCell align="center">{t('contrastBrandColor')}</TableCell> : null}
                    {kind === 'airports' ? sortableHeader('city', t('city')) : null}
                    {kind === 'airports' ? sortableHeader('country', t('country')) : null}
                    {kind === 'airports' ? sortableHeader('terminals', t('terminals')) : null}
                  </>
                )}
                {sortableHeader('references', t('referencingFlights'), 'right')}
                <TableCell align="right">{t('actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedCatalogRows.map((row) => {
                const { entry } = row;
                const key = catalogEntryKey(kind, entry);
                if (kind === 'aircraft-types') {
                  const aircraft = entry as AircraftType;
                  return (
                    <TableRow key={key} hover selected={!row.derived && selected.has(key)}>
                      {row.derived ? <TableCell padding="checkbox" /> : selectionCell(key)}
                      <TableCell sx={{ fontWeight: 650, whiteSpace: 'nowrap' }}>{aircraft.icao}</TableCell>
                      <TableCell>{aircraft.iata}</TableCell>
                      <TableCell>{row.derived ? UNLISTED_REFERENCE_NOTE : aircraft.displayName}</TableCell>
                       <TableCell>{aircraft.manufacturer ?? t('notAvailable')}</TableCell>
                      <TableCell align="right">{referenceCount(aircraft.icao) ?? t('notAvailable')}</TableCell>
                      {rowActions(row)}
                    </TableRow>
                  );
                }
                if (kind === 'airlines') {
                  const airline = entry as Airline;
                  const logos = [airline.horizontalLogoResourcePath, airline.horizontalDarkLogoResourcePath, airline.symbolLogoResourcePath].filter(
                    (path) => path !== null,
                  ).length;
                  return (
                    <TableRow key={key} hover selected={!row.derived && selected.has(key)}>
                      {row.derived ? <TableCell padding="checkbox" /> : selectionCell(key)}
                      <TableCell sx={{ fontWeight: 650, whiteSpace: 'nowrap' }}>{airline.code}</TableCell>
                      <TableCell>{row.derived ? UNLISTED_REFERENCE_NOTE : displayName(airline.nameZh, airline.nameEn, t('notAvailable'))}</TableCell>
                       <TableCell>{airline.alliance ?? t('notAvailable')}</TableCell>
                      <TableCell>
                        <Chip size="small" variant="outlined" label={`${logos}/3`} />
                      </TableCell>
                      <TableCell align="center">
                        <Box sx={{ width: 24, height: 24, borderRadius: '50%', bgcolor: airline.brandColors.primary ? hexToCss(airline.brandColors.primary) : 'rgba(0,0,0,0.12)', border: 1, borderColor: 'divider', mx: 'auto' }} />
                      </TableCell>
                      <TableCell align="center">
                        <Box sx={{ width: 24, height: 24, borderRadius: '50%', bgcolor: airline.brandColors.contrast ? hexToCss(airline.brandColors.contrast) : 'rgba(0,0,0,0.12)', border: 1, borderColor: 'divider', mx: 'auto' }} />
                      </TableCell>
                      <TableCell align="right">{referenceCount(airline.code) ?? t('notAvailable')}</TableCell>
                      {rowActions(row)}
                    </TableRow>
                  );
                }
                const airport = entry as Airport;
                return (
                  <TableRow key={key} hover selected={!row.derived && selected.has(key)}>
                    {row.derived ? <TableCell padding="checkbox" /> : selectionCell(key)}
                    <TableCell sx={{ fontWeight: 650, whiteSpace: 'nowrap' }}>{airport.code}</TableCell>
                    <TableCell>{row.derived ? UNLISTED_REFERENCE_NOTE : displayName(airport.nameZh, airport.nameEn, t('notAvailable'))}</TableCell>
                    <TableCell>{displayName(airport.cityZh, airport.cityEn, t('notAvailable'))}</TableCell>
                    <TableCell>{displayName(airport.countryZh, airport.countryEn, t('notAvailable'))}</TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                        {airport.terminals.length === 0 ? (
                          t('notAvailable')
                        ) : (
                          airport.terminals.map((terminal) => <Chip key={terminal} size="small" variant="outlined" label={terminal} />)
                        )}
                      </Box>
                    </TableCell>
                    <TableCell align="right">{referenceCount(airport.code) ?? t('notAvailable')}</TableCell>
                    {rowActions(row)}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <CatalogEntryDialog
        kind={kind}
        open={dialogOpen}
        initial={editing?.entry ?? null}
        saving={saving}
        allianceSuggestions={allianceSuggestions}
        manufacturerSuggestions={manufacturerSuggestions}
        onSave={(entry) => void saveEntry(entry)}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
      />
      <FlightDialog
        open={flightDialogOpen}
        initial={editingFlight}
        catalogs={catalogs}
        saving={savingFlight}
        onSave={(payload) => void saveFlight(payload)}
        onRecordChanged={(updated) => {
          setEditingFlight(updated);
          setFlights((current) => current.map((flight) => flight.id === updated.id ? updated : flight));
        }}
        onClose={() => {
          setFlightDialogOpen(false);
          setEditingFlight(null);
        }}
      />
      <ConfirmDialog
        open={deletingFlight !== null}
        title={t('deleteFlight')}
        message={t('deleteFlightMessage', {
          flightNumber: deletingFlight ? displayFlightNumber(deletingFlight.airlineCode, deletingFlight.flightNumber) : '',
          date: deletingFlight?.departureDate ?? '',
        })}
        confirmLabel={t('delete')}
        danger
        onConfirm={() => void deleteOneFlight()}
        onClose={() => setDeletingFlight(null)}
      />
      <ConfirmDialog
        open={bulkDeletingFlights}
        title={t('deleteFlights')}
        message={t('deleteFlightsMessage', { count: selected.size })}
        confirmLabel={t('delete')}
        danger
        onConfirm={() => void deleteSelectedFlights()}
        onClose={() => setBulkDeletingFlights(false)}
      />
      <ConfirmDialog
        open={deleting !== null && !deleteForce}
        title={t('deleteCatalogEntry')}
        message={t('deleteCatalogMessage', { key: deleting ? catalogEntryKey(kind, deleting) : '' })}
        confirmLabel={t('delete')}
        danger
        onConfirm={() => void deleteEntry()}
        onClose={() => setDeleting(null)}
      />
      <ConfirmDialog
        open={deleting !== null && deleteForce}
        title={t('entryReferenced')}
        message={t('entryReferencedMessage', { key: deleting ? catalogEntryKey(kind, deleting) : '' })}
        confirmLabel={t('deleteAnyway')}
        danger
        onConfirm={() => void deleteEntry(true)}
        onClose={() => {
          setDeleting(null);
          setDeleteForce(false);
        }}
      />
      <ConfirmDialog
        open={bulkDeleting && !bulkDeleteForce}
        title={t('deleteCatalogEntries')}
        message={t('deleteCatalogSelectionMessage', { count: selected.size })}
        confirmLabel={t('delete')}
        danger
        onConfirm={() => void deleteSelectedEntries()}
        onClose={() => setBulkDeleting(false)}
      />
      <ConfirmDialog
        open={bulkDeleting && bulkDeleteForce}
        title={t('entriesReferenced')}
        message={t('entriesReferencedMessage', { count: selected.size })}
        confirmLabel={t('deleteAnyway')}
        danger
        onConfirm={() => void deleteSelectedEntries(true)}
        onClose={() => {
          setBulkDeleting(false);
          setBulkDeleteForce(false);
        }}
      />
    </Box>
  );
}
