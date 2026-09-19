// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Full flight-detail sheet: the individual travel record behind any archive
 * row/card. Shows the airline mark, route, date, airline and flight number up
 * front, every persisted detail (terminals, times, aircraft, registration,
 * seat, notes), the three boarding-pass slots, a unique downloadable
 * file list of every bound resource (boarding-pass roles first, then
 * attachments). The sheet is strictly read-only; editing and deleting stay
 * available from the list and grid views.
 */

import { Box, Chip, Dialog, DialogContent, Divider, IconButton, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ConfirmationNumberOutlinedIcon from '@mui/icons-material/ConfirmationNumberOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import type { Airport, Catalogs, FlightRecord } from '../api/types';
import { displayFlightNumber, displayName, unlistedCodeLabel } from '../utils/format';
import { resourceUrl } from '../rfg/api';
import { useTranslation, type TranslationKey } from '../i18n';
import { ResourceImage } from '../resources/ResourceImage';
import { isImageResource, leafName } from '../resources/resourcePicker';
import { BoardingPassFrame, DEFAULT_FRAME_ASPECT } from '../boardingpass/BoardingPassFrame';
import { BOARDING_PASS_SLOTS, slotLayout, slotResourcePath, type BoardingPassSlotKey } from '../boardingpass/passPresentation';
import { airlineLabel, RouteConnector } from './flightDisplay';
import { AirlineHorizontalLogo, AirlineLogo } from './AirlineLogo';
import { buildFlightVisualTheme, createBlendedBackground, hexToCss } from '../theme/colors';
import { scaled, useDialogScale } from '../utils/dialogScale';

function airportOf(catalogs: Catalogs | null, code: string): Airport | undefined {
  return catalogs?.airports.find((airport) => airport.code === code);
}

const SLOT_ROLE_LABEL: Record<BoardingPassSlotKey, TranslationKey> = {
  paperBoardingPassFront: 'boardingPassFront',
  paperBoardingPassBack: 'boardingPassBack',
};

interface FlightFileRow {
  path: string;
  roles: TranslationKey[];
}

/** The flight's bound resources as unique file rows: the three boarding-pass
 *  slots in their fixed order first (when bound), then general attachments.
 *  A resource bound to several roles appears exactly once, with every role
 *  listed on the same row. */
function flightFileRows(flight: FlightRecord): FlightFileRow[] {
  const rows: FlightFileRow[] = [];
  const byPath = new Map<string, FlightFileRow>();
  const add = (path: string | null, role: TranslationKey) => {
    if (path === null) return;
    const existing = byPath.get(path);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
      return;
    }
    const row: FlightFileRow = { path, roles: [role] };
    byPath.set(path, row);
    rows.push(row);
  };
  for (const slot of BOARDING_PASS_SLOTS) add(slotResourcePath(flight, slot), SLOT_ROLE_LABEL[slot]);
  add(flight.electronicBoardingPassResourcePath, 'electronicBoardingPass');
  for (const path of flight.attachmentResourcePaths) add(path, 'attachmentRole');
  return rows;
}

/** Small row preview: images render their cached thumbnail, every non-image
 *  file shows the same centred generic file icon as the resource picker. */
function FileRowPreview({ path }: { path: string }) {
  if (isImageResource(path)) return <ResourceImage resourcePath={path} size={40} alt={leafName(path)} />;
  return (
    <Box
      aria-hidden
      sx={{
        width: 40,
        height: 40,
        flex: '0 0 auto',
        display: 'grid',
        placeItems: 'center',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        color: 'text.secondary',
      }}
    >
      <InsertDriveFileOutlinedIcon fontSize="small" />
    </Box>
  );
}

function RouteEnd({
  code,
  terminal,
  time,
  airport,
  align,
  terminalLabel,
  notAvailable,
}: {
  code: string;
  terminal: string | null;
  time: string | null;
  airport: Airport | undefined;
  align: 'left' | 'right';
  terminalLabel: string;
  notAvailable: string;
}) {
  return (
    <Box sx={{ flex: '1 1 0', minWidth: 0, textAlign: align }}>
      <Typography variant="h4" component="div" sx={{ fontWeight: 800, letterSpacing: 1, lineHeight: 1.1 }}>
        {code}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} noWrap>
        {airport ? displayName(airport.nameZh, airport.nameEn, notAvailable) : unlistedCodeLabel(code)}
      </Typography>
      <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 600 }}>
        {time ?? notAvailable}
        {terminal ? ` · ${terminalLabel} ${terminal}` : ''}
      </Typography>
    </Box>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 120, flex: '1 1 140px' }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {value}
      </Typography>
    </Box>
  );
}

export function FlightDetailDialog({
  flight,
  catalogs,
  airlineNames,
  open,
  onClose,
}: {
  flight: FlightRecord | null;
  catalogs: Catalogs | null;
  airlineNames: Map<string, string>;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const dialogScale = useDialogScale();
  // All hooks run unconditionally above; without a record there is nothing to show.
  if (!flight) return null;

  const flightNumber = displayFlightNumber(flight.airlineCode, flight.flightNumber);
  const airline = catalogs?.airlines.find((entry) => entry.code === flight.airlineCode);
  const airlineName = airlineLabel(flight.airlineCode, airlineNames);
  const aircraftType = flight.aircraftTypeIcao
    ? catalogs?.aircraftTypes.find((type) => type.icao === flight.aircraftTypeIcao)
    : undefined;
  const na = t('notAvailable');
  const fileRows = flightFileRows(flight);
  const visualTheme = buildFlightVisualTheme(airline ?? null, flight);
  const background = createBlendedBackground(
    visualTheme.airlinePrimary,
    visualTheme.airlineContrast,
    visualTheme.flightColor,
    visualTheme.flightColor,
    theme.palette.mode === 'dark',
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      fullScreen={fullScreen}
      aria-labelledby="flight-detail-title"
      scroll="paper"
      slotProps={{
        paper: {
          sx: {
            overflow: 'hidden',
            height: { xs: '100%', sm: scaled(750, dialogScale) },
            width: { xs: undefined, sm: scaled(900, dialogScale) },
            maxWidth: '95vw',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 0,
            background,
            backgroundClip: 'padding-box',
            backgroundOrigin: 'padding-box',
            backgroundSize: '110% 110%',
            backgroundPosition: 'center',
            boxShadow: 'none',
          },
        },
      }}
    >
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr) minmax(88px, 112px) minmax(0, 1fr)', sm: 'minmax(0, 1fr) minmax(160px, 220px) minmax(0, 1fr)' }, alignItems: 'center', gap: 1, px: { xs: 2, sm: 3 }, py: 2 }}>
        <Box data-testid="airline-horizontal-logo-region" sx={{ gridColumn: 2, gridRow: 1, width: '100%', height: { xs: 32, sm: 42 }, display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
          <AirlineHorizontalLogo horizontalLogoResourcePath={airline?.horizontalLogoResourcePath} horizontalDarkLogoResourcePath={airline?.horizontalDarkLogoResourcePath} label={airlineName} maxWidth={220} maxHeight={42} />
        </Box>
        <Box sx={{ gridColumn: 1, gridRow: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2 }}>
          <AirlineLogo
            symbolLogoResourcePath={airline?.symbolLogoResourcePath}
            code={flight.airlineCode}
            label={airlineName}
            width={48}
            height={48}
          />
          <Box sx={{ minWidth: 0 }}>
            <Typography id="flight-detail-title" variant="h5" component="h2" sx={{ fontWeight: 700 }}>
              {flightNumber}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {airlineName}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ gridColumn: 3, gridRow: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: { xs: 0.5, sm: 1.5 } }}>
          <Typography variant="body1" sx={{ fontWeight: 600, fontSize: '1.15rem', lineHeight: 1.25, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
            {flight.departureDate}
          </Typography>
          <Tooltip title={t('closeDetails')}>
            <IconButton aria-label={t('closeDetails')} onClick={onClose} edge="end">
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <DialogContent dividers sx={{ px: { xs: 2, sm: 3 }, flex: '1 1 auto', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1, sm: 2 }, py: 1 }}>
          <RouteEnd
            code={flight.departureAirport}
            terminal={flight.departureTerminal}
            time={flight.departureTime}
            airport={airportOf(catalogs, flight.departureAirport)}
            align="left"
            terminalLabel={t('departureTerminal')}
            notAvailable={na}
          />
          <RouteConnector sx={{ flex: '0 1 120px' }} />
          <RouteEnd
            code={flight.arrivalAirport}
            terminal={flight.arrivalTerminal}
            time={flight.arrivalTime}
            airport={airportOf(catalogs, flight.arrivalAirport)}
            align="right"
            terminalLabel={t('arrivalTerminal')}
            notAvailable={na}
          />
        </Box>

        <Divider sx={{ my: 2.5 }} />
        <Typography variant="subtitle2" gutterBottom>
          {t('boardingPasses')}
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, my: 2, flexDirection: { xs: 'column', sm: 'row' } }}>
          {BOARDING_PASS_SLOTS.map((slot) => {
            const resourcePath = slotResourcePath(flight, slot);
            return (
              <Box key={slot} sx={{ flex: '1 1 0', minWidth: 0 }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75, fontWeight: 600 }}>
                  {t(SLOT_ROLE_LABEL[slot])}
                </Typography>
                {resourcePath ? (
                  <BoardingPassFrame
                    slot={slot}
                    flightId={flight.id}
                    resourcePath={resourcePath}
                    layout={slotLayout(flight, slot)}
                    layered={false}
                  />
                ) : (
                  // Empty placeholder matching the BoardingPassFrame dimensions
                  // and aspect ratio for consistent alignment
                  <Box
                    sx={{
                      position: 'relative',
                      width: '100%',
                      aspectRatio: String(DEFAULT_FRAME_ASPECT),
                      borderRadius: 1,
                      border: 1,
                      borderColor: 'divider',
                      bgcolor: 'action.hover',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 0.5,
                      color: 'text.disabled',
                    }}
                  >
                    <ConfirmationNumberOutlinedIcon sx={{ fontSize: 24 }} />
                    <Typography variant="caption" sx={{ lineHeight: 1.3 }}>
                      {t('notAvailable')}
                    </Typography>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>

        <Divider sx={{ my: 2.5 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'flex-start' }}>
          <DetailItem
            label={t('aircraftType')}
            value={
              aircraftType
                ? `${aircraftType.displayName} (${aircraftType.icao})`
                : flight.aircraftTypeIcao
                  ? unlistedCodeLabel(flight.aircraftTypeIcao)
                  : na
            }
          />
          <DetailItem label={t('registration')} value={flight.registration ?? na} />
          <DetailItem label={t('seat')} value={flight.seat ?? na} />
          {visualTheme.flightColor ? (
            <Box
              role="group"
              aria-label={t('flightColors')}
              sx={{ minWidth: 120, flex: '1 1 140px' }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {t('flightColors')}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, mt: 0.5, alignItems: 'center' }}>
                <Box
                  aria-hidden
                  sx={{ width: 24, height: 24, borderRadius: '50%', bgcolor: hexToCss(visualTheme.flightColor), border: 1, borderColor: 'divider' }}
                />
              </Box>
            </Box>
          ) : null}
        </Box>

        {flight.notes ? (
          <Box sx={{ mt: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              {t('notes')}
            </Typography>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
              {flight.notes}
            </Typography>
          </Box>
        ) : null}

        {fileRows.length > 0 ? (
          <Box sx={{ mt: 2, maxHeight: 180, overflow: 'auto' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
              {t('flightFiles')} · {fileRows.length}
            </Typography>
            <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 1 }}>
              {fileRows.map((row) => (
                <Box component="li" key={row.path} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
                  <FileRowPreview path={row.path} />
                  <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
                    <Typography variant="body2" noWrap title={row.path} sx={{ fontWeight: 600 }}>
                      {leafName(row.path)}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.25 }}>
                      {row.roles.map((role) => (
                        <Chip key={role} size="small" variant="outlined" label={t(role)} />
                      ))}
                      {row.path === flight.electronicBoardingPassResourcePath && flight.electronicBoardingPass?.extraction ? (
                        <Chip size="small" variant="outlined" label={t('hasBoardingPassLayout')} />
                      ) : null}
                    </Box>
                  </Box>
                  <Tooltip title={t('downloadFile', { name: leafName(row.path) })}>
                    <IconButton
                      component="a"
                      href={resourceUrl(row.path)}
                      download={leafName(row.path)}
                      aria-label={t('downloadFile', { name: leafName(row.path) })}
                      size="small"
                      sx={{ flex: '0 0 auto' }}
                    >
                      <DownloadOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              ))}
            </Box>
          </Box>
        ) : null}

        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2.5 }}>
          {t('lastUpdated', { date: flight.updatedAt.slice(0, 10) })}
        </Typography>
      </DialogContent>
    </Dialog>
  );
}
