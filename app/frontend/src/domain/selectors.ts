// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { BusinessData, FlightRecord } from './types';
export interface FlightFilters { query?: string; airline?: string; dateFrom?: string; dateTo?: string }

export function selectFlights(data: BusinessData, filters: FlightFilters = {}): FlightRecord[] {
  const query = filters.query?.trim().toLowerCase() ?? '';
  return data.flights.filter((flight) => {
    if (filters.airline && flight.airlineCode !== filters.airline) return false;
    if (filters.dateFrom && flight.departureDate < filters.dateFrom) return false;
    if (filters.dateTo && flight.departureDate > filters.dateTo) return false;
    const haystack = `${flight.airlineCode}${flight.flightNumber} ${flight.departureAirport} ${flight.arrivalAirport} ${flight.registration ?? ''} ${flight.seat ?? ''} ${flight.notes}`.toLowerCase();
    return !query || haystack.includes(query);
  }).sort((left, right) => right.departureDate.localeCompare(left.departureDate) || (right.departureTime ?? '').localeCompare(left.departureTime ?? '') || Number(right.flightNumber) - Number(left.flightNumber));
}
