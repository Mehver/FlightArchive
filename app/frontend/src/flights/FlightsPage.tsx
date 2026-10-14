// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Flight display page: the product's centre. One shared filter/search bar
 * drives the same frontend domain records into two user-switchable views
 * (concise list and card grid); every record opens the full
 * flight-detail sheet. Browse-only: no create/edit/delete controls.
 */

import { useMemo, useState } from 'react';
import {
  Box,
  MenuItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from '@mui/material';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import { useAppState } from '../state/AppState';
import { useBusinessData } from '../domain/BusinessDataProvider';
import { selectFlights } from '../domain/selectors';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { displayName } from '../utils/format';
import { FlightDetailDialog } from './FlightDetailDialog';
import { FlightListView } from './FlightListView';
import { FlightGridView } from './FlightGridView';
import { useFlightViewMode, type FlightViewMode } from './flightViewPreference';
import { useTranslation } from '../i18n';
import { ImageRequestScope } from '../resources/ImageRequestScope';

export function FlightsPage() {
  const { t } = useTranslation();
  const { catalogs } = useAppState();
  const { data, phase, loadError, reload } = useBusinessData();
  const [query, setQuery] = useState('');
  const [airline, setAirline] = useState('');
  const [viewMode, setViewMode] = useFlightViewMode();
  const [visitedViews, setVisitedViews] = useState<ReadonlySet<FlightViewMode>>(() => new Set([viewMode]));
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const flights = useMemo(() => data ? selectFlights(data, { query, airline }) : null, [data, query, airline]);
  const detail = data?.flights.find((flight) => flight.id === detailId) ?? null;
  const detailActuallyOpen = detailOpen && detail !== null;

  const airlineNames = useMemo(() => new Map((catalogs?.airlines ?? []).map((item) => [item.code, displayName(item.nameZh, item.nameEn, t('notAvailable'))])), [catalogs, t]);
  const airlines = useMemo(() => new Map((catalogs?.airlines ?? []).map((item) => [item.code, item])), [catalogs]);
  const airports = useMemo(() => new Map((catalogs?.airports ?? []).map((item) => [item.code, item])), [catalogs]);

  const viewProps = {
    flights: flights ?? [],
    airlineNames,
    airlines,
    airports,
    onOpen: (flight: { id: string }) => {
      setDetailId(flight.id);
      setDetailOpen(true);
    },
  };

  const viewToggle = (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={viewMode}
      onChange={(_event, next: FlightViewMode | null) => {
        if (next) {
          setVisitedViews((visited) => visited.has(next) ? visited : new Set([...visited, next]));
          setViewMode(next);
        }
      }}
      aria-label={t('switchDisplayView')}
    >
      <ToggleButton value="list" aria-label={t('viewList')}>
        <Tooltip title={t('viewList')}>
          <ViewListOutlinedIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
      <ToggleButton value="grid" aria-label={t('viewGrid')}>
        <Tooltip title={t('viewGrid')}>
          <GridViewOutlinedIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
    </ToggleButtonGroup>
  );

  return (
    <Box>
      <PageHeader
        title={t('flightDisplay')}
        subtitle={t('archiveCount', { count: flights?.length ?? 0 })}
        actions={viewToggle}
      />

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
        <TextField
          size="small"
          label={t('search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 220, flex: '1 1 220px' }}
          slotProps={{ htmlInput: { 'aria-label': t('searchFlights') } }}
        />
        <TextField
          size="small"
          select
          label={t('airline')}
          value={airline}
          onChange={(e) => setAirline(e.target.value)}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">{t('allAirlines')}</MenuItem>
          {(catalogs?.airlines ?? []).map((a) => (
            <MenuItem key={a.code} value={a.code}>
              {a.code} — {displayName(a.nameZh, a.nameEn, t('notAvailable'))}
            </MenuItem>
          ))}
        </TextField>
      </Box>

      {phase === 'error' ? (
        <ErrorState message={loadError?.message ?? t('failedToLoadFlights')} onRetry={() => void reload()} />
      ) : flights === null ? (
        <LoadingState label={t('loadingFlights')} />
      ) : (
        <>
          {flights.length === 0 ? (
            <EmptyState title={t('noFlights')} hint={t('noFlightsHint')} />
          ) : null}
          {visitedViews.has('list') ? (
            <Box hidden={viewMode !== 'list' || flights.length === 0} aria-hidden={viewMode !== 'list' || flights.length === 0} sx={{ display: viewMode === 'list' && flights.length > 0 ? 'block' : 'none' }}>
              <ImageRequestScope active={viewMode === 'list' && !detailActuallyOpen}><FlightListView {...viewProps} /></ImageRequestScope>
            </Box>
          ) : null}
          {visitedViews.has('grid') ? (
            <Box hidden={viewMode !== 'grid' || flights.length === 0} aria-hidden={viewMode !== 'grid' || flights.length === 0} sx={{ display: viewMode === 'grid' && flights.length > 0 ? 'block' : 'none' }}>
              <ImageRequestScope active={viewMode === 'grid' && !detailActuallyOpen}><FlightGridView {...viewProps} /></ImageRequestScope>
            </Box>
          ) : null}
        </>
      )}

      <ImageRequestScope active={detailActuallyOpen}>
        <FlightDetailDialog
          flight={detail}
          catalogs={catalogs}
          airlineNames={airlineNames}
          open={detailActuallyOpen}
          onClose={() => setDetailOpen(false)}
        />
      </ImageRequestScope>
    </Box>
  );
}
