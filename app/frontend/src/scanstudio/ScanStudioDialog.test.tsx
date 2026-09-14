// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FlightRecord, PaperBoardingPassLayout } from '../api/types';
import { LanguageProvider } from '../i18n';
import { ScanStudioDialog } from './ScanStudioDialog';

const mocks = vi.hoisted(() => ({
  crop: vi.fn(),
  updateFlight: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: { updateFlight: mocks.updateFlight },
}));
vi.mock('../rfg/api', () => ({ resourceUrl: (path: string) => `/images/${path}` }));
vi.mock('../state/AppState', () => ({
  useAppState: () => ({ notify: vi.fn(), showError: vi.fn() }),
}));
vi.mock('./scanWorkerClient', () => ({
  ScanWorkerClient: class {
    crop = mocks.crop;
    detect = vi.fn();
    dispose = vi.fn();
  },
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

const context = {
  clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), stroke: vi.fn(),
  rect: vi.fn(), fill: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), arc: vi.fn(), fillRect: vi.fn(),
  setLineDash: vi.fn(), measureText: vi.fn(() => ({ width: 10 })), fillText: vi.fn(), strokeRect: vi.fn(),
};

function layout(crop: PaperBoardingPassLayout['crop']): PaperBoardingPassLayout {
  return {
    schemaVersion: 1,
    algorithm: 'adaptive',
    crop,
    templateId: 'bp-247.svg',
    placement: { scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0 },
  };
}

function flight(savedLayout?: PaperBoardingPassLayout): FlightRecord {
  return {
    id: 'flight-1', flightNumber: 'CA123', airlineCode: 'CA', departureAirport: 'PEK', arrivalAirport: 'SHA',
    departureTerminal: null, arrivalTerminal: null, departureDate: '2026-08-01', departureTime: null, arrivalTime: null,
    aircraftTypeIcao: null, registration: null, seat: null, notes: '', createdAt: '', updatedAt: '',
    paperBoardingPassFrontResourcePath: 'boarding-pass.png', paperBoardingPassBackResourcePath: null,
    electronicBoardingPassResourcePath: null, attachmentResourcePaths: [],
    paperBoardingPassLayouts: savedLayout ? { paperBoardingPassFront: savedLayout } : {},
    boardingPassColor: null,
  };
}

function renderDialog(record: FlightRecord, onSaved = vi.fn()) {
  return render(
    <LanguageProvider>
      <ScanStudioDialog open flight={record} slot="paperBoardingPassFront" onSaved={onSaved} onClose={vi.fn()} />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  imageSize.width = 400;
  imageSize.height = 200;
  vi.stubGlobal('Image', TestImage);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:crop'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  Object.defineProperties(HTMLCanvasElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  mocks.crop.mockResolvedValue({ blob: new Blob(['crop']), width: 100, height: 50 });
  mocks.updateFlight.mockResolvedValue({ flight: flight() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ScanStudioDialog rotated-rectangle workflow', () => {
  it('restores a legacy layout from its summary and exposes an independent magnifier', async () => {
    const legacy = layout({ centerX: 200, centerY: 100, width: 160, height: 80, rotationDegrees: 15, corners: [{ x: -1, y: -1 }] });
    renderDialog(flight(legacy));

    await screen.findByText(/saved layout/i);
    fireEvent.click(screen.getByRole('button', { name: /back.*detect/i }));
    // The magnifier is a floating overlay that becomes visible on pointer move.
    const cropCanvas = await screen.findByRole('img', { name: 'Crop editor canvas' });
    fireEvent.pointerMove(cropCanvas, { clientX: 100, clientY: 50 });
    expect(await screen.findByRole('img', { name: 'Magnified source pixels' })).not.toBeNull();
    expect(screen.getByRole('slider', { name: 'Magnification' })).not.toBeNull();
    expect(mocks.crop).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ centerX: 200, centerY: 100, width: 160, height: 80, rotationDegrees: 15 }));
    expect(mocks.crop.mock.calls[0][1]).not.toHaveProperty('corners');
  });

  it('gates an out-of-bounds saved rectangle in the crop stage', async () => {
    renderDialog(flight(layout({ centerX: 20, centerY: 20, width: 100, height: 80, rotationDegrees: 0 })));

    await waitFor(() => expect(screen.getByRole('tab', { name: /detect & crop/i }).getAttribute('aria-selected')).toBe('true'));
    expect(mocks.crop).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: /place on template/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves only the rectangle summary', async () => {
    const onSaved = vi.fn();
    renderDialog(flight(layout({ centerX: 200, centerY: 100, width: 160, height: 80, rotationDegrees: 0 })), onSaved);

    await waitFor(() => expect((screen.getByRole('button', { name: /save layout/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /auto-fit/i }));
    fireEvent.click(screen.getByRole('button', { name: /save layout/i }));
    await waitFor(() => expect(mocks.updateFlight).toHaveBeenCalledOnce());
    const saved = mocks.updateFlight.mock.calls[0][1].paperBoardingPassLayouts.paperBoardingPassFront.crop;
    expect(saved).toEqual({ centerX: 200, centerY: 100, width: 160, height: 80, rotationDegrees: 0 });
    expect(saved).not.toHaveProperty('corners');
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('clears the magnifier when the pointer leaves the crop canvas', async () => {
    renderDialog(flight(layout({ centerX: 200, centerY: 100, width: 160, height: 80, rotationDegrees: 0 })));

    await screen.findByText(/saved layout/i);
    fireEvent.click(screen.getByRole('button', { name: /back.*detect/i }));
    const canvas = screen.getByRole('img', { name: 'Crop editor canvas' }) as HTMLCanvasElement;
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) });
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 100 });
    const clearsBeforeLeave = context.clearRect.mock.calls.length;

    fireEvent.pointerLeave(canvas);

    await waitFor(() => expect(context.clearRect.mock.calls.length).toBeGreaterThan(clearsBeforeLeave));
  });
});

describe('ScanStudioDialog clearLayout', () => {
  it('clearLayout removes only the active slot and keeps the others', async () => {
    // Setup: flight with layouts for front and back
    const flightWithLayouts: FlightRecord = {
      ...flight(),
      paperBoardingPassLayouts: {
        paperBoardingPassFront: { schemaVersion: 1, algorithm: 'adaptive', crop: { centerX: 50, centerY: 50, width: 100, height: 100, rotationDegrees: 0 }, templateId: 'bp-247.svg', placement: { scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0 } },
        paperBoardingPassBack: { schemaVersion: 1, algorithm: 'canny', crop: { centerX: 50, centerY: 50, width: 100, height: 100, rotationDegrees: 0 }, templateId: 'bp-247.svg', placement: { scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0 } },
      },
    };

    // Open dialog for front slot
    renderDialog(flightWithLayouts);
    await screen.findByText(/saved layout/i);

    // Click clear button
    fireEvent.click(screen.getByRole('button', { name: /remove the stored crop layout/i }));

    // Verify updateFlight was called with front removed but back preserved
    await waitFor(() => expect(mocks.updateFlight).toHaveBeenCalledOnce());
    const savedLayouts = mocks.updateFlight.mock.calls[0][1].paperBoardingPassLayouts;
    expect(savedLayouts).not.toHaveProperty('paperBoardingPassFront');
    expect(savedLayouts).toHaveProperty('paperBoardingPassBack');
    expect(savedLayouts.paperBoardingPassBack.algorithm).toBe('canny');
  });
});

describe('ScanStudioDialog magnifier viewport and cursor affordances', () => {
  // Opens a restored 0° layout on the crop stage and returns the crop canvas
  // with a 1:1 bounding rect so image coordinates equal client coordinates.
  async function openCropEditor(record: FlightRecord): Promise<HTMLCanvasElement> {
    renderDialog(record);
    await screen.findByText(/saved layout/i);
    fireEvent.click(screen.getByRole('button', { name: /back.*detect/i }));
    const canvas = screen.getByRole('img', { name: 'Crop editor canvas' }) as HTMLCanvasElement;
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) });
    return canvas;
  }

  const squareLayout = () => layout({ centerX: 200, centerY: 100, width: 160, height: 80, rotationDegrees: 0 });

  it('renders a materially larger, mobile-safe magnifier viewport', async () => {
    const canvas = await openCropEditor(flight(squareLayout()));

    // Trigger a pointer move to make the floating magnifier visible.
    fireEvent.pointerMove(canvas, { clientX: canvas.width / 2, clientY: canvas.height / 2 });

    const magnifier = screen.getByRole('img', { name: 'Magnified source pixels' }) as HTMLCanvasElement;
    expect(magnifier.width).toBe(320);
    expect(magnifier.height).toBe(320);
    expect(magnifier.className).toContain('scanStudioMagnifierCanvas');
  });

  it('draws the crop selection overlay in the magnifier after a pointer move', async () => {
    const canvas = await openCropEditor(flight(squareLayout()));
    const arcsBefore = context.arc.mock.calls.length;
    const movesBefore = context.moveTo.mock.calls.length;

    // The top-left corner is within the source view at the default 2x
    // magnification, so this verifies the overlay's mapped position is visible.
    fireEvent.pointerMove(canvas, { clientX: canvas.width / 2 - 80, clientY: canvas.height / 2 - 40 });

    const magnifierArcs = context.arc.mock.calls.slice(arcsBefore);
    expect(magnifierArcs.some(([x, y]) => x >= 0 && x <= 320 && y >= 0 && y <= 320)).toBe(true);
    // One path move begins the crop boundary. The removed cursor crosshair
    // would add two more full-canvas lines to this magnifier render.
    expect(context.moveTo.mock.calls.slice(movesBefore)).toHaveLength(1);
  });

  it('keeps tiny source images fully inside the magnifier sample', async () => {
    imageSize.width = 100;
    imageSize.height = 60;
    const canvas = await openCropEditor(flight(layout({ centerX: 50, centerY: 30, width: 40, height: 20, rotationDegrees: 0 })));

    fireEvent.pointerMove(canvas, { clientX: canvas.width / 2, clientY: canvas.height / 2 });

    const draw = context.drawImage.mock.calls.filter((call) => call.length === 9).at(-1);
    expect(draw).toBeDefined();
    expect(draw?.[3]).toBeLessThanOrEqual(imageSize.width);
    expect(draw?.[4]).toBeLessThanOrEqual(imageSize.height);
  });

  it('uses contextual cursors for corner, edge, inside, and outside', async () => {
    const canvas = await openCropEditor(flight(squareLayout()));

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    // Top-left corner resizes along the NW-SE diagonal.
    fireEvent.pointerMove(canvas, { clientX: cx - 80, clientY: cy - 40 });
    expect(canvas.style.cursor).toBe('nwse-resize');
    // Top-right corner resizes along the NE-SW diagonal.
    fireEvent.pointerMove(canvas, { clientX: cx + 80, clientY: cy - 40 });
    expect(canvas.style.cursor).toBe('nesw-resize');

    // Top edge midpoint resizes vertically.
    fireEvent.pointerMove(canvas, { clientX: cx, clientY: cy - 40 });
    expect(canvas.style.cursor).toBe('n-resize');
    // Right edge midpoint resizes horizontally.
    fireEvent.pointerMove(canvas, { clientX: cx + 80, clientY: cy });
    expect(canvas.style.cursor).toBe('e-resize');

    // Interior moves.
    fireEvent.pointerMove(canvas, { clientX: cx, clientY: cy });
    expect(canvas.style.cursor).toBe('move');

    // Outside the quad falls back to the default cursor.
    fireEvent.pointerMove(canvas, { clientX: 10, clientY: 10 });
    expect(canvas.style.cursor).toBe('default');
  });

  it('uses a normal corner as an immediate resize and enters rotation from the handle or Shift+corner', async () => {
    const canvas = await openCropEditor(flight(squareLayout()));
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: cx - 80, clientY: cy - 40 });
    expect(canvas.style.cursor).toBe('nwse-resize');
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    // The handle is 28 canvas pixels outward from the top edge.
    fireEvent.pointerMove(canvas, { clientX: cx, clientY: cy - 68 });
    expect(canvas.style.cursor).toBe('grab');
    fireEvent.pointerDown(canvas, { pointerId: 2, button: 0, clientX: cx, clientY: cy - 68 });
    expect(canvas.style.cursor).toBe('grabbing');
    fireEvent.pointerUp(canvas, { pointerId: 2 });

    fireEvent.pointerDown(canvas, { pointerId: 3, button: 0, shiftKey: true, clientX: cx - 80, clientY: cy - 40 });
    expect(canvas.style.cursor).toBe('grabbing');
  });
});
