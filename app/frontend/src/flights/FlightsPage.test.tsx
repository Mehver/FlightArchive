// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessDataContextValue } from '../domain/BusinessDataProvider';
import type { FlightRecord } from '../api/types';
import { LanguageProvider } from '../i18n';
import { browserImageRenderer } from '../resources/browserImageRenderer';
import { useBusinessData } from '../domain/BusinessDataProvider';
import { useAppState } from '../state/AppState';

vi.mock('../domain/BusinessDataProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../domain/BusinessDataProvider')>();
  return { ...actual, useBusinessData: vi.fn() };
});
vi.mock('../state/AppState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/AppState')>();
  return { ...actual, useAppState: vi.fn() };
});

import { FlightsPage } from './FlightsPage';

const FLIGHT: FlightRecord = {
  id: 'flight-1', flightNumber: '123', airlineCode: 'CA', departureAirport: 'PEK', arrivalAirport: 'SHA',
  departureTerminal: null, arrivalTerminal: null, departureDate: '2026-08-01', departureTime: null, arrivalTime: null,
  aircraftTypeIcao: null, registration: null, seat: null, notes: '', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  paperBoardingPassFrontResourcePath: 'passes/front.png', paperBoardingPassBackResourcePath: null,
  electronicBoardingPassResourcePath: null, attachmentResourcePaths: [], boardingPassColor: null,
  paperBoardingPassLayouts: {
    paperBoardingPassFront: {
      schemaVersion: 1, algorithm: 'adaptive', templateId: 'bp-247.svg',
      crop: { centerX: 100, centerY: 50, width: 180, height: 70, rotationDegrees: 2 },
      placement: { scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0 },
    },
  },
};

let flights: FlightRecord[];

function businessValue(): BusinessDataContextValue {
  return {
    phase: 'ready', data: { schemaVersion: 1, flights, airlines: [], airports: [], aircraftTypes: [], settings: {} }, loadError: null,
    documents: {} as BusinessDataContextValue['documents'], saveAllProgress: { status: 'idle', completed: 0, total: 5, failed: [] },
    createFlight: vi.fn(), updateFlight: vi.fn(), deleteFlight: vi.fn(), upsertCatalogEntry: vi.fn(), deleteCatalogEntries: vi.fn(),
    updateSettings: vi.fn(), retryDocument: vi.fn(), saveDocument: vi.fn(), saveAll: vi.fn(), importBusinessData: vi.fn(),
    exportBusinessData: vi.fn(), downloadBusinessData: vi.fn(), reload: vi.fn(), whenIdle: vi.fn(),
  } as unknown as BusinessDataContextValue;
}

describe('FlightsPage retained image surfaces', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('flightarchive.ui.language', 'en');
    flights = [FLIGHT];
    vi.mocked(useBusinessData).mockImplementation(businessValue);
    vi.mocked(useAppState).mockReturnValue({ catalogs: { airlines: [], airports: [], aircraftTypes: [] } } as unknown as ReturnType<typeof useAppState>);
    vi.spyOn(browserImageRenderer, 'render').mockResolvedValue({ url: 'blob:stable-preview', width: 512, height: 200 } as Awaited<ReturnType<typeof browserImageRenderer.render>>);
    vi.spyOn(browserImageRenderer, 'release').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps visited list/grid DOM and a closed detail mounted without repeating render work', async () => {
    const view = render(<LanguageProvider><FlightsPage /></LanguageProvider>);
    await waitFor(() => expect(browserImageRenderer.render).toHaveBeenCalledTimes(1));
    expect(vi.mocked(browserImageRenderer.render).mock.calls[0][0]).toMatchObject({ virtualPath: 'passes/front.png', maxDimension: 512 });

    fireEvent.click(screen.getByRole('button', { name: 'Card Grid View' }));
    await waitFor(() => expect(browserImageRenderer.render).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('button', { name: /CA123/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'List View' }));
    await Promise.resolve();
    expect(browserImageRenderer.render).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('button', { name: /CA0123/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /CA0123/ }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await waitFor(() => expect(browserImageRenderer.render).toHaveBeenCalledTimes(4));
    expect(vi.mocked(browserImageRenderer.render).mock.calls
      .map(([request]) => request)
      .filter((request) => request.crop)
      .every((request) => request.maxDimension === 512)).toBe(true);
    const detailImage = screen.getAllByAltText(/paper front/i).find((image) => image.closest('[role="dialog"]'))!;
    fireEvent.load(detailImage);
    const detailSrc = detailImage.getAttribute('src');

    fireEvent.click(screen.getByRole('button', { name: 'Close Details' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /CA0123/ }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(browserImageRenderer.render).toHaveBeenCalledTimes(4);
    expect(screen.getAllByAltText(/paper front/i).find((image) => image.closest('[role="dialog"]'))?.getAttribute('src')).toBe(detailSrc);

    flights = [];
    view.rerender(<LanguageProvider><FlightsPage /></LanguageProvider>);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('No Flights Yet')).toBeTruthy();
  });

  it('uses the shared 512 target for prepared and unprepared paper previews in list, grid, and detail', async () => {
    const reverseLayoutFlight: FlightRecord = {
      ...FLIGHT,
      id: 'flight-2',
      flightNumber: '456',
      paperBoardingPassFrontResourcePath: 'passes/front-unprepared.png',
      paperBoardingPassBackResourcePath: 'passes/back-prepared.png',
      paperBoardingPassLayouts: { paperBoardingPassBack: FLIGHT.paperBoardingPassLayouts!.paperBoardingPassFront },
    };
    flights = [{ ...FLIGHT, paperBoardingPassBackResourcePath: 'passes/back-unprepared.png' }, reverseLayoutFlight];
    render(<LanguageProvider><FlightsPage /></LanguageProvider>);

    await waitFor(() => expect(browserImageRenderer.render).toHaveBeenCalledTimes(4));
    fireEvent.click(screen.getByRole('button', { name: 'Card Grid View' }));
    await waitFor(() => expect(browserImageRenderer.render).toHaveBeenCalledTimes(6));
    fireEvent.click(screen.getByRole('button', { name: /CA123/ }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await waitFor(() => expect(browserImageRenderer.render).toHaveBeenCalledTimes(10));
    fireEvent.click(screen.getByRole('button', { name: 'Close Details' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /CA456/ }));
    await waitFor(() => expect(browserImageRenderer.render).toHaveBeenCalledTimes(14));

    const requests = vi.mocked(browserImageRenderer.render).mock.calls.map(([request]) => request);
    const preparedFront = requests.filter((request) => request.virtualPath === 'passes/front.png' && request.crop && request.maxDimension === 512);
    const unpreparedBack = requests.filter((request) => request.virtualPath === 'passes/back-unprepared.png' && !request.crop && request.maxDimension === 512);
    const unpreparedFront = requests.filter((request) => request.virtualPath === 'passes/front-unprepared.png' && !request.crop && request.maxDimension === 512);
    const preparedBack = requests.filter((request) => request.virtualPath === 'passes/back-prepared.png' && request.crop && request.maxDimension === 512);
    // List + grid + detail all render the prepared front; list + detail render
    // the unprepared back (the grid intentionally presents only the front).
    expect(preparedFront).toHaveLength(3);
    expect(unpreparedBack).toHaveLength(2);
    expect(unpreparedFront).toHaveLength(3);
    expect(preparedBack).toHaveLength(2);
  });

  it('reactivates the underlying view when the selected detail record disappears', async () => {
    const remaining: FlightRecord = { ...FLIGHT, id: 'flight-remaining', flightNumber: '456', paperBoardingPassFrontResourcePath: 'passes/remaining.png' };
    flights = [FLIGHT, remaining];
    let firstRemainingSignal: AbortSignal | undefined;
    vi.mocked(browserImageRenderer.render).mockImplementation((request) => {
      if (request.virtualPath === 'passes/remaining.png') {
        firstRemainingSignal ??= request.signal;
        return new Promise(() => undefined);
      }
      return Promise.resolve({ url: `blob:${request.virtualPath}`, width: 512, height: 200, type: 'image/webp' });
    });
    const view = render(<LanguageProvider><FlightsPage /></LanguageProvider>);
    await waitFor(() => expect(vi.mocked(browserImageRenderer.render).mock.calls.filter(([request]) => request.virtualPath === 'passes/remaining.png')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /CA0123/ }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await waitFor(() => expect(firstRemainingSignal?.aborted).toBe(true));

    flights = [remaining];
    view.rerender(<LanguageProvider><FlightsPage /></LanguageProvider>);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(vi.mocked(browserImageRenderer.render).mock.calls.filter(([request]) => request.virtualPath === 'passes/remaining.png')).toHaveLength(2));
    expect(screen.getByRole('button', { name: /CA0456/ })).toBeTruthy();
  });
});
