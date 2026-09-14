// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FlightRecord } from '../api/types';
import { LanguageProvider } from '../i18n';
import { ElectronicBoardingPassStudio } from './ElectronicBoardingPassStudio';
import { ELECTRONIC_CROP_PRESETS_STORAGE_KEY } from './electronicCropPresets';

const mocks = vi.hoisted(() => ({
  updateFlight: vi.fn(),
  listFlights: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: { updateFlight: mocks.updateFlight, listFlights: mocks.listFlights },
}));
vi.mock('../rfg/api', () => ({ resourceUrl: (path: string) => `/images/${path}` }));
vi.mock('../state/AppState', () => ({
  useAppState: () => ({ notify: vi.fn(), showError: vi.fn() }),
}));

const imageSize = { width: 400, height: 200 };

class TestImage {
  naturalWidth = imageSize.width;
  naturalHeight = imageSize.height;
  onload: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.(new Event('load')));
  }
}

function pixelData(fill: (x: number, y: number) => [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(imageSize.width * imageSize.height * 4);
  for (let y = 0; y < imageSize.height; y += 1) {
    for (let x = 0; x < imageSize.width; x += 1) {
      const [r, g, b] = fill(x, y);
      const index = (y * imageSize.width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return { width: imageSize.width, height: imageSize.height, data, colorSpace: 'srgb' } as ImageData;
}

let pixels = pixelData(() => [255, 0, 0]);

const context = {
  clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
  stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(), setLineDash: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
  getImageData: vi.fn(() => pixels),
};

function flight(presentation?: FlightRecord['electronicBoardingPass'], boardingPassColor: FlightRecord['boardingPassColor'] = null): FlightRecord {
  return {
    id: 'flight-1', flightNumber: 'CA123', airlineCode: 'CA', departureAirport: 'PEK', arrivalAirport: 'SHA',
    departureTerminal: null, arrivalTerminal: null, departureDate: '2026-08-01', departureTime: null, arrivalTime: null,
    aircraftTypeIcao: null, registration: null, seat: null, notes: '', createdAt: '', updatedAt: '',
    paperBoardingPassFrontResourcePath: null, paperBoardingPassBackResourcePath: null,
    electronicBoardingPassResourcePath: 'pass.png', attachmentResourcePaths: [],
    electronicBoardingPass: presentation,
    boardingPassColor,
  };
}

function renderStudio(record: FlightRecord, onSaved = vi.fn(), onClose = vi.fn()) {
  render(
    <LanguageProvider>
      <ElectronicBoardingPassStudio open flight={record} slot="electronicBoardingPass" onSaved={onSaved} onClose={onClose} />
    </LanguageProvider>,
  );
  return { onSaved, onClose };
}

function numberField(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  pixels = pixelData(() => [255, 0, 0]);
  vi.stubGlobal('Image', TestImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  mocks.updateFlight.mockResolvedValue({ flight: flight() });
  mocks.listFlights.mockResolvedValue({ flights: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ElectronicBoardingPassStudio', () => {
  it('saves the axis-aligned extraction with its sampled color', async () => {
    const { onSaved } = renderStudio(flight());
    await screen.findByRole('img', { name: 'Crop editor canvas' });

    fireEvent.click(screen.getByRole('button', { name: /next.*colors/i }));
    fireEvent.click(screen.getByRole('button', { name: /save layout/i }));

    await waitFor(() => expect(mocks.updateFlight).toHaveBeenCalledOnce());
    expect(mocks.updateFlight.mock.calls[0][0]).toBe('flight-1');
    expect(mocks.updateFlight.mock.calls[0][1]).toEqual({
      electronicBoardingPass: {
        schemaVersion: 1,
        extraction: {
          crop: { centerX: 200, centerY: 100, width: 400, height: 200, mirrorAcrossImageCenterX: false },
          presetName: 'custom',
        },
      },
      boardingPassColor: '#FF0000',
    });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('pins the crop horizontally to the image centre while mirroring is enabled', async () => {
    renderStudio(flight());
    await screen.findByRole('img', { name: 'Crop editor canvas' });

    fireEvent.change(numberField('Width'), { target: { value: '100' } });
    fireEvent.change(numberField('Center X'), { target: { value: '100' } });
    expect(numberField('Center X').value).toBe('100');

    fireEvent.click(screen.getByRole('switch', { name: /mirror/i }));

    expect(numberField('Center X').disabled).toBe(true);
    expect(numberField('Center X').value).toBe('200');

    fireEvent.click(screen.getByRole('button', { name: /next.*colors/i }));
    fireEvent.click(screen.getByRole('button', { name: /save layout/i }));
    await waitFor(() => expect(mocks.updateFlight).toHaveBeenCalledOnce());
    expect(mocks.updateFlight.mock.calls[0][1].electronicBoardingPass.extraction.crop).toEqual({
      centerX: 200,
      centerY: 100,
      width: 100,
      height: 200,
      mirrorAcrossImageCenterX: true,
    });
  });

  it('persists a typed preset name with the flight layout, not localStorage', async () => {
    renderStudio(flight());
    await screen.findByRole('img', { name: 'Crop editor canvas' });

    fireEvent.change(numberField('Crop Preset'), { target: { value: 'Home Screen' } });
    fireEvent.click(screen.getByRole('button', { name: /next.*colors/i }));
    fireEvent.click(screen.getByRole('button', { name: /save layout/i }));

    await waitFor(() => expect(mocks.updateFlight).toHaveBeenCalledOnce());
    expect(mocks.updateFlight.mock.calls[0][1].electronicBoardingPass.extraction.presetName).toBe('Home Screen');
    expect(localStorage.getItem(ELECTRONIC_CROP_PRESETS_STORAGE_KEY)).toBeNull();
  });

  it('uses an authoritative named layout and removes an orphaned browser preset', async () => {
    localStorage.setItem(
      ELECTRONIC_CROP_PRESETS_STORAGE_KEY,
      JSON.stringify([{ name: 'Old browser preset', crop: { centerX: 1, centerY: 1, width: 1, height: 1 } }]),
    );
    mocks.listFlights.mockResolvedValue({
      flights: [flight({ schemaVersion: 1, extraction: { crop: { centerX: 120, centerY: 60, width: 80, height: 40, mirrorAcrossImageCenterX: false }, presetName: 'Seat' } })],
    });
    renderStudio(flight());
    await screen.findByRole('img', { name: 'Crop editor canvas' });

    fireEvent.mouseDown(numberField('Crop Preset'));
    expect(screen.queryByRole('option', { name: 'Old browser preset' })).toBeNull();
    fireEvent.click(await screen.findByRole('option', { name: 'Seat' }));

    expect(numberField('Center X').value).toBe('120');
    expect(numberField('Center Y').value).toBe('60');
    expect(numberField('Width').value).toBe('80');
    expect(numberField('Height').value).toBe('40');
    expect(numberField('Crop Preset').value).toBe('Seat');
    expect(localStorage.getItem(ELECTRONIC_CROP_PRESETS_STORAGE_KEY)).toBeNull();
  });

  it('restores a saved presentation, pinning the mirrored crop on load', async () => {
    renderStudio(
      flight(
        {
          schemaVersion: 1,
          extraction: {
            crop: { centerX: 150, centerY: 80, width: 120, height: 60, mirrorAcrossImageCenterX: true },
            presetName: 'Seat',
          },
        },
        '#010203',
      ),
    );
    await screen.findByRole('img', { name: 'Crop editor canvas' });

    expect(numberField('Width').value).toBe('120');
    expect(numberField('Center X').value).toBe('200');
    expect(numberField('Center X').disabled).toBe(true);
    expect(numberField('Crop Preset').value).toBe('Seat');

    fireEvent.click(screen.getByRole('button', { name: /next.*colors/i }));
    fireEvent.click(screen.getByRole('button', { name: /save layout/i }));
    await waitFor(() => expect(mocks.updateFlight).toHaveBeenCalledOnce());
    const payload = mocks.updateFlight.mock.calls[0][1];
    expect(payload.electronicBoardingPass.extraction.presetName).toBe('Seat');
    expect(payload.electronicBoardingPass.extraction.crop).toEqual({ centerX: 200, centerY: 80, width: 120, height: 60, mirrorAcrossImageCenterX: true });
    expect(payload.boardingPassColor).toBe('#010203');
  });

  it('auto-extracts the boarding-pass color from the crop centre', async () => {
    pixels = pixelData((x) => (x < 300 ? [200, 10, 10] : [10, 10, 220]));
    renderStudio(flight());
    await screen.findByRole('img', { name: 'Crop editor canvas' });

    fireEvent.click(screen.getByRole('tab', { name: 'Colors' }));

    const colorGroup = await screen.findByRole('group', { name: 'Boarding Pass Color' });
    await waitFor(() => expect((within(colorGroup).getByRole('textbox') as HTMLInputElement).value).toBe('C80A0A'));
  });
});
