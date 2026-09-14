// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Compact-mode composition contract of BoardingPassTrio (archive cards):
 * a prepared paper backing shows its true saved crop from the paper-only
 * preview route. Electronic layouts have no preview endpoint, so their corner
 * card states that a layout is saved without requesting an invalid URL; only
 * explicitly unprepared electronic scans keep the raw thumbnail.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FlightRecord, PaperBoardingPassLayout } from '../api/types';
import { LanguageProvider } from '../i18n';
import { BoardingPassTrio } from './BoardingPassTrio';

afterEach(cleanup);

const LAYOUT: PaperBoardingPassLayout = {
  schemaVersion: 1,
  algorithm: 'adaptive',
  crop: { centerX: 100, centerY: 50, width: 200, height: 100, rotationDegrees: 0 },
  templateId: 'bp-247.svg',
  placement: { scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0 },
};

function flight(overrides: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: 'f-1',
    flightNumber: '1234',
    airlineCode: 'CA',
    departureAirport: 'PEK',
    arrivalAirport: 'SHA',
    departureTerminal: null,
    arrivalTerminal: null,
    departureDate: '2026-08-01',
    departureTime: null,
    arrivalTime: null,
    aircraftTypeIcao: null,
    registration: null,
    seat: null,
  
    notes: '',
    createdAt: '2026-08-01T00:00:00',
    updatedAt: '2026-08-01T00:00:00',
    paperBoardingPassFrontResourcePath: null,
    paperBoardingPassBackResourcePath: null,
    electronicBoardingPassResourcePath: null,
    attachmentResourcePaths: [],
    boardingPassColor: null,
    ...overrides,
  };
}

function renderCompact(record: FlightRecord) {
  return render(
    <LanguageProvider>
      <BoardingPassTrio flight={record} compact />
    </LanguageProvider>,
  );
}

const imgSrcs = (container: HTMLElement) => Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('src'));

/** Back prepared, front merely bound: the back side is the backing sheet. */
const PREPARED_BACK: Partial<FlightRecord> = {
  paperBoardingPassFrontResourcePath: 'obj/front.png',
  paperBoardingPassBackResourcePath: 'obj/back.png',
  paperBoardingPassLayouts: { paperBoardingPassBack: LAYOUT },
};

describe('BoardingPassTrio compact prepared slots', () => {
  it('shows the backing paper side from the preview route, preserving the whole crop', () => {
    const { container } = renderCompact(flight(PREPARED_BACK));
    const img = container.querySelector('img[src="/api/flights/f-1/boarding-passes/paperBoardingPassBack/preview"]');
    expect(img).not.toBeNull();
    // The true crop is never secondarily CSS-cropped.
    expect(getComputedStyle(img!).objectFit).toBe('contain');
    expect(imgSrcs(container)).not.toContain('/images/obj/back.png');
  });

  it('degrades a failed prepared backing preview to the plain sheet, never the raw scan', () => {
    const { container } = renderCompact(flight(PREPARED_BACK));
    const previewSrc = '/api/flights/f-1/boarding-passes/paperBoardingPassBack/preview';
    fireEvent.error(container.querySelector(`img[src="${previewSrc}"]`)!);
    expect(container.querySelector(`img[src="${previewSrc}"]`)).toBeNull();
    expect(imgSrcs(container)).not.toContain('/images/obj/back.png');
  });

  it('resets a failed backing image when its source changes', () => {
    const { container, rerender } = render(
      <LanguageProvider>
        <BoardingPassTrio flight={flight(PREPARED_BACK)} compact />
      </LanguageProvider>,
    );
    const firstSrc = '/api/flights/f-1/boarding-passes/paperBoardingPassBack/preview';
    fireEvent.error(container.querySelector(`img[src="${firstSrc}"]`)!);
    expect(container.querySelector(`img[src="${firstSrc}"]`)).toBeNull();

    rerender(
      <LanguageProvider>
        <BoardingPassTrio flight={flight({ ...PREPARED_BACK, id: 'f-2' })} compact />
      </LanguageProvider>,
    );
    // The new source renders its image again instead of staying hidden.
    expect(container.querySelector('img[src="/api/flights/f-2/boarding-passes/paperBoardingPassBack/preview"]')).not.toBeNull();
  });

  it('keeps the raw cover thumbnail for an explicitly unprepared backing side', () => {
    const { container } = renderCompact(
      flight({ paperBoardingPassFrontResourcePath: 'obj/front.png', paperBoardingPassBackResourcePath: 'obj/back.png' }),
    );
    const img = container.querySelector('img[src="/images/obj/back.png"]');
    expect(img).not.toBeNull();
    expect(getComputedStyle(img!).objectFit).toBe('cover');
    expect(imgSrcs(container).some((src) => src?.includes('/preview'))).toBe(false);
  });

  it('shows a prepared electronic mini-card as a saved-layout status without a preview request', () => {
    const { container } = renderCompact(
      flight({
        electronicBoardingPassResourcePath: 'obj/electronic.png',
        electronicBoardingPass: {
          schemaVersion: 1,
          extraction: {
            crop: { centerX: 100, centerY: 100, width: 200, height: 200, mirrorAcrossImageCenterX: false },
          },
        },
      }),
    );
    expect(container.querySelector('img[src*="electronicBoardingPass/preview"]')).toBeNull();
    expect(imgSrcs(container)).not.toContain('/images/obj/electronic.png');
    expect(screen.getByRole('img', { name: /electronic boarding pass.*saved layout/i })).toBeTruthy();
    expect(container.querySelector('[data-testid="QrCode2OutlinedIcon"]')).not.toBeNull();
  });

  it('keeps the raw cover thumbnail for an explicitly unprepared electronic scan', () => {
    const { container } = renderCompact(flight({ electronicBoardingPassResourcePath: 'obj/electronic.png' }));
    expect(imgSrcs(container)).toContain('/images/obj/electronic.png');
    expect(imgSrcs(container).some((src) => src?.includes('/preview'))).toBe(false);
  });

  it('renders plain decorative sheets and placeholders without any image when nothing is bound', () => {
    const { container } = renderCompact(flight());
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});
