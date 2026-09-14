// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Preview card grid archive view: each card shows the front boarding pass
 * as a prominent cover image with a small airline badge above the route,
 * flight number, and date.
 * Clicking a card opens the FlightDetailDialog (the detail card). */

import { Box, IconButton, Paper, Tooltip, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import type { Airport } from '../api/types';
import { displayFlightNumber } from '../utils/format';
import { useTranslation } from '../i18n';
import { BoardingPassFrame, DEFAULT_FRAME_ASPECT } from '../boardingpass/BoardingPassFrame';
import { slotLayout, slotResourcePath } from '../boardingpass/passPresentation';
import {
  airlineLabel,
  clickableRecordProps,
  RouteConnector,
  type FlightViewProps,
} from './flightDisplay';
import { AirlineLogo } from './AirlineLogo';
import { buildFlightVisualTheme, createBlendedBackground } from '../theme/colors';

export function FlightGridView({ flights, airlineNames, airlines, airports, onOpen, onEdit, onDelete, openLabel }: FlightViewProps) {
  const { t } = useTranslation();
  const muiTheme = useTheme();
  const labelFor = openLabel ?? ((flightNumber: string) => t('openFlightDetails', { flightNumber }));
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 250px), 1fr))',
      }}
    >
      {flights.map((flight) => {
        const flightNumber = displayFlightNumber(flight.airlineCode, flight.flightNumber);
        const airline = airlines?.get(flight.airlineCode);
        const airlineName = airlineLabel(flight.airlineCode, airlineNames);
        const visualTheme = buildFlightVisualTheme(airline ?? null, flight);
        const airportName = (code: string, airport: Airport | undefined) => airport?.nameZh || airport?.nameEn || code;
        const departureAirportName = airportName(flight.departureAirport, airports?.get(flight.departureAirport));
        const arrivalAirportName = airportName(flight.arrivalAirport, airports?.get(flight.arrivalAirport));
        const background = createBlendedBackground(
          visualTheme.airlinePrimary,
          visualTheme.airlineContrast,
          visualTheme.flightColor,
          visualTheme.flightColor,
          muiTheme.palette.mode === 'dark',
        );
        return (
          <Paper
            key={flight.id}
            variant="outlined"
            {...clickableRecordProps(() => onOpen(flight), labelFor(flightNumber))}
            sx={{
              display: 'flex',
              flexDirection: 'column',
              cursor: 'pointer',
              borderRadius: 0,
              background,
              transition: 'background 120ms ease',
              overflow: 'hidden',
              backgroundClip: 'padding-box',
              backgroundOrigin: 'padding-box',
              backgroundSize: '110% 110%',
              backgroundPosition: 'center',
              '&:hover': { boxShadow: 'none' },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
            }}
          >
             {/* Front boarding pass as the card cover image, larger than the
                 compact trio stack so it reads as a prominent ticket header. */}
             <Box sx={{ p: 1.5, pb: 1.25 }}>
              <BoardingPassFrame
                slot="paperBoardingPassFront"
                flightId={flight.id}
                resourcePath={slotResourcePath(flight, 'paperBoardingPassFront')}
                layout={slotLayout(flight, 'paperBoardingPassFront')}
                aspectRatio={DEFAULT_FRAME_ASPECT}
                compact
                layered={false}
              />
             </Box>
             <Box sx={{ p: 1.5, pt: 1.25, display: 'flex', flexDirection: 'column', gap: 0.75, flex: '1 1 auto', minWidth: 0 }}>
               <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                 <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                    <AirlineLogo symbolLogoResourcePath={airline?.symbolLogoResourcePath} code={flight.airlineCode} label={airlineName} width={24} height={24} />
                    <Typography variant="h5" sx={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{flightNumber}</Typography>
                 </Box>
                <Typography variant="subtitle1" color="text.secondary" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {flight.departureDate}
                </Typography>
              </Box>
              <Box
                component="div"
                aria-label={`${flight.departureAirport} ${departureAirportName} to ${flight.arrivalAirport} ${arrivalAirportName}`}
                sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1 }, my: 0.5, minWidth: 0 }}
              >
                <Box sx={{ minWidth: 0, flex: '0 1 35%' }}>
                  <Typography variant="h6" component="div" noWrap sx={{ fontWeight: 700 }}>{flight.departureAirport}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{departureAirportName}</Typography>
                </Box>
                <RouteConnector sx={{ flex: 1, minWidth: 20 }} iconSize={{ xs: 17, sm: 20 }} />
                <Box sx={{ minWidth: 0, flex: '0 1 35%', textAlign: 'right' }}>
                  <Typography variant="h6" component="div" noWrap sx={{ fontWeight: 700 }}>{flight.arrivalAirport}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{arrivalAirportName}</Typography>
                </Box>
              </Box>
              <Typography variant="caption" color="text.secondary" noWrap aria-label={`${airlineName}${flight.aircraftTypeIcao ? `, ${flight.aircraftTypeIcao}` : ''}${flight.seat ? `, seat ${flight.seat}` : ''}`}>
                {airlineName}{flight.aircraftTypeIcao ? ` · ${flight.aircraftTypeIcao}` : ''}{flight.seat ? ` · ${flight.seat}` : ''}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', mt: 'auto', pt: 0.5 }}>
                {onEdit || onDelete ? (
                  <Box sx={{ display: 'flex', alignItems: 'center' }}>
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
                  </Box>
                ) : null}
              </Box>
            </Box>
          </Paper>
        );
      })}
    </Box>
  );
}
