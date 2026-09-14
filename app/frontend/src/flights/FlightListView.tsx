// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Concise archive list view: one typographic row per flight. The airline /
 *  electronic-pass branding paints a blended multi-layer background with
 *  smooth colour transitions. Fixed record information and the route preview
 *  stay in separate, single-line groups for reliable banner alignment. */

import { Box, IconButton, Paper, Tooltip, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ConfirmationNumberOutlinedIcon from '@mui/icons-material/ConfirmationNumberOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import { displayFlightNumber } from '../utils/format';
import { useTranslation } from '../i18n';
import { BoardingPassFrame } from '../boardingpass/BoardingPassFrame';
import { boundSlotCount, slotLayout, slotResourcePath } from '../boardingpass/passPresentation';
import { buildFlightVisualTheme, createBlendedBackground } from '../theme/colors';
import {
  airlineLabel,
  clickableRecordProps,
  RouteConnector,
  type FlightViewProps,
} from './flightDisplay';
import { AirlineLogo } from './AirlineLogo';

const LIST_IDENTIFIER_SX = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontVariantNumeric: 'tabular-nums',
} as const;
const LIST_TEXT_SX = { fontSize: '0.875rem', lineHeight: 1.3 } as const;
const LIST_GAP = 1.25;
const LIST_COMPACT_GAP = 0.75;
const LIST_LOGO_GAP = 2;
const LIST_PREVIEW_GAP = 2;

/** Archive banners alone pad a purely numeric suffix for scan-friendly alignment. */
export function displayListFlightNumber(airlineCode: string, flightNumber: string): string {
  const displayed = displayFlightNumber(airlineCode, flightNumber);
  const match = /^([A-Za-z]+)(\d+)$/.exec(displayed);
  return match ? `${match[1]}${match[2].padStart(4, '0')}` : displayed;
}

export function FlightListView({ flights, airlineNames, airlines, onOpen, onEdit, onDelete, openLabel }: FlightViewProps) {
  const { t } = useTranslation();
  const muiTheme = useTheme();
  const labelFor = openLabel ?? ((flightNumber: string) => t('openFlightDetails', { flightNumber }));
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: { xs: 592, md: 800 } }}>
      {flights.map((flight) => {
        const flightNumber = displayListFlightNumber(flight.airlineCode, flight.flightNumber);
        const bound = boundSlotCount(flight);
        const airline = airlines?.get(flight.airlineCode);
        const airlineName = airlineLabel(flight.airlineCode, airlineNames);
        const flightTheme = buildFlightVisualTheme(airline ?? null, flight);
        const background = createBlendedBackground(
          flightTheme.airlinePrimary,
          flightTheme.airlineContrast,
            flightTheme.flightColor,
            flightTheme.flightColor,
          muiTheme.palette.mode === 'dark',
        );
        return (
          <Paper
            key={flight.id}
            variant="outlined"
            {...clickableRecordProps(() => onOpen(flight), labelFor(flightNumber))}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: LIST_GAP,
              px: { xs: 1.25, sm: 2 },
              py: 0.75,
              cursor: 'pointer',
              transition: 'background 120ms ease',
              borderRadius: 0,
              background,
              overflow: 'hidden',
              backgroundClip: 'padding-box',
              backgroundOrigin: 'padding-box',
              backgroundSize: '110% 110%',
              backgroundPosition: 'center',
              '&:hover': {
                bgcolor: 'action.hover',
              },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
            }}
          >
            <Box data-testid="flight-list-info-group" sx={{ display: 'flex', alignItems: 'center', gap: LIST_GAP, flex: '0 0 auto' }}>
              <Box data-testid="flight-list-logo-host" sx={{ mr: LIST_LOGO_GAP - LIST_GAP }}>
                <AirlineLogo
                  code={flight.airlineCode}
                  symbolLogoResourcePath={airline?.symbolLogoResourcePath}
                  label={airlineName}
                  width={24}
                  height={24}
                />
              </Box>
              <Box data-testid="flight-list-identifier-date" sx={{ display: 'flex', alignItems: 'center', gap: LIST_COMPACT_GAP, flex: '0 0 auto' }}>
                <Typography variant="body2" noWrap sx={{ ...LIST_IDENTIFIER_SX, width: 88, flex: '0 0 auto', fontSize: '1rem', lineHeight: 1.2, fontWeight: 800 }}>
                  {flightNumber}
                </Typography>
                <Box sx={{ width: 96, flex: '0 0 auto' }}>
                  <Typography variant="body2" noWrap sx={{ ...LIST_IDENTIFIER_SX, ...LIST_TEXT_SX, fontWeight: 550 }}>
                    {flight.departureDate}
                  </Typography>
                  {flight.departureTime ? (
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ ...LIST_IDENTIFIER_SX, fontSize: '0.75rem', lineHeight: 1.3 }}>
                      {flight.departureTime}
                      {flight.arrivalTime ? ` → ${flight.arrivalTime}` : ''}
                    </Typography>
                  ) : null}
                </Box>
              </Box>
              <Typography variant="body2" noWrap sx={{ ...LIST_TEXT_SX, fontWeight: 600, flex: '0 0 auto' }}>
                {airlineName}
              </Typography>
            </Box>
            <Box data-testid="flight-list-route-group" sx={{ display: 'flex', alignItems: 'center', gap: LIST_GAP, ml: 'auto', flex: '0 0 auto' }}>
              <Box data-testid="flight-list-route-ticket-strip" sx={{ display: 'flex', alignItems: 'center', gap: LIST_PREVIEW_GAP, flex: '0 0 auto' }}>
                <Box data-testid="flight-list-route-preview" sx={{ display: 'flex', alignItems: 'center', gap: LIST_COMPACT_GAP, flex: '0 0 auto' }}>
                  <Typography variant="body2" noWrap sx={{ ...LIST_TEXT_SX, minWidth: 0 }}>
                    {flight.departureAirport}{flight.departureTerminal ? ` ${flight.departureTerminal}` : ''}
                  </Typography>
                  <RouteConnector sx={{ flex: '0 0 76px', minWidth: 76, gap: 0.25 }} iconSize={15} iconMargin={0} />
                  <Typography variant="body2" noWrap sx={{ ...LIST_TEXT_SX, minWidth: 0 }}>
                    {flight.arrivalAirport}{flight.arrivalTerminal ? ` ${flight.arrivalTerminal}` : ''}
                  </Typography>
                </Box>
                <Box data-testid="flight-list-paper-front-preview" sx={{ width: 58, flex: '0 0 auto' }}>
                  <BoardingPassFrame
                    slot="paperBoardingPassFront"
                    flightId={flight.id}
                    resourcePath={slotResourcePath(flight, 'paperBoardingPassFront')}
                    layout={slotLayout(flight, 'paperBoardingPassFront')}
                    compact
                    layered={false}
                  />
                </Box>
                <Box data-testid="flight-list-paper-back-preview" sx={{ width: 58, flex: '0 0 auto', display: { xs: 'none', md: 'block' } }}>
                  <BoardingPassFrame
                    slot="paperBoardingPassBack"
                    flightId={flight.id}
                    resourcePath={slotResourcePath(flight, 'paperBoardingPassBack')}
                    layout={slotLayout(flight, 'paperBoardingPassBack')}
                    compact
                    layered={false}
                  />
                </Box>
              </Box>
              <Box
              sx={{
                width: 40,
                flex: '0 0 auto',
                display: { xs: 'none', md: 'flex' },
                alignItems: 'center',
                gap: LIST_COMPACT_GAP,
                color: 'text.secondary',
              }}
            >
              {bound > 0 ? (
                <Tooltip title={t('boardingPassesBound', { count: bound })}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
                    <ConfirmationNumberOutlinedIcon sx={{ fontSize: 16 }} />
                    <Typography variant="caption" component="span" sx={{ fontSize: '0.75rem', lineHeight: 1.3 }}>
                      {bound}
                    </Typography>
                  </Box>
                </Tooltip>
              ) : null}
              </Box>
              <Box sx={{ width: 40, flex: '0 0 auto', display: { xs: 'none', md: 'block' } }}>
              {flight.seat ? (
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem', lineHeight: 1.3 }}>
                  {flight.seat}
                </Typography>
              ) : null}
              </Box>
              <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: LIST_COMPACT_GAP,
                flex: '0 0 auto',
              }}
            >
              {onEdit ? (
                <Tooltip title={t('edit')}>
                  <IconButton
                    size="small"
                    aria-label={t('editFlight', { flightNumber })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onEdit(flight);
                    }}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              ) : null}
              {onDelete ? (
                <Tooltip title={t('delete')}>
                  <IconButton
                    size="small"
                    aria-label={t('deleteFlight', { flightNumber })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(flight);
                    }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              ) : null}
                <ChevronRightIcon sx={{ color: 'text.disabled' }} aria-hidden />
              </Box>
            </Box>
          </Paper>
        );
      })}
      </Box>
    </Box>
  );
}
