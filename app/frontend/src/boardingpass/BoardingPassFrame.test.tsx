// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Black-box characterization of BoardingPassFrame's presentation contract:
 * absent slots show a deliberate placeholder, bound-but-layout-less slots
 * show the cached thumbnail behind an "unprepared scan" badge, and prepared
 * slots compose the persisted template + placement geometry with the
  * server-rendered upright rectangular crop from the boarding-pass preview route.
 * Prepared previews come from /api/.../preview, unprepared scans from the
 * thumbnail route — never the original route.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PaperBoardingPassLayout } from '../api/types';
import { LanguageProvider } from '../i18n';
import { BoardingPassFrame } from './BoardingPassFrame';

afterEach(cleanup);

function renderFrame(ui: React.ReactElement) {
  return render(<LanguageProvider>{ui}</LanguageProvider>);
}

const LAYOUT: PaperBoardingPassLayout = {
  schemaVersion: 1,
  algorithm: 'adaptive',
  crop: { centerX: 100, centerY: 50, width: 200, height: 100, rotationDegrees: 0 },
  templateId: 'bp-247.svg',
  placement: { scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0 },
};

describe('BoardingPassFrame', () => {
  it('shows the deliberate placeholder for an absent slot', () => {
    const { container } = renderFrame(<BoardingPassFrame slot="paperBoardingPassFront" flightId="f-1" resourcePath={null} layout={undefined} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: /paper front/i })).not.toBeNull();
  });

  it('shows the bound scan from the thumbnail route with an unprepared badge', () => {
    renderFrame(<BoardingPassFrame slot="paperBoardingPassBack" flightId="f-1" resourcePath="obj/scan.png" layout={undefined} />);
    const img = screen.getByAltText(/paper back/i);
    expect(img.getAttribute('src')).toBe('/images/obj/scan.png');
    expect(screen.getByText(/unprepared scan/i)).not.toBeNull();
  });

  it('composes template backing and the preview-route crop for a prepared slot', () => {
    const { container } = renderFrame(
      <BoardingPassFrame slot="paperBoardingPassFront" flightId="f-1" resourcePath="obj/scan.png" layout={LAYOUT} />,
    );
    const images = Array.from(container.querySelectorAll('img'));
    // Template artwork (aria-hidden) plus the server-rendered preview crop.
    expect(images.length).toBe(2);
    expect(images.some((img) => img.getAttribute('aria-hidden') === 'true')).toBe(true);
    // The prepared slot requests the true upright rectangular crop from the preview
    // route — never the generic thumbnail or the original resource route.
    expect(images.some((img) => img.getAttribute('src') === '/api/flights/f-1/boarding-passes/paperBoardingPassFront/preview')).toBe(true);
    expect(images.every((img) => !img.getAttribute('src')?.startsWith('/images/'))).toBe(true);
    expect(images.every((img) => !img.getAttribute('src')?.startsWith('/res/'))).toBe(true);
    // Percentage placement geometry itself is covered by passPresentation.test.
    expect(screen.queryByText(/unprepared scan/i)).toBeNull();
  });

  it('falls back to the honest unprepared presentation for unusable persisted geometry', () => {
    const brokenLayout: PaperBoardingPassLayout = { ...LAYOUT, crop: { ...LAYOUT.crop, width: 0 } };
    renderFrame(<BoardingPassFrame slot="paperBoardingPassFront" flightId="f-1" resourcePath="obj/scan.png" layout={brokenLayout} />);
    expect(screen.getByText(/unprepared scan/i)).not.toBeNull();
  });

  it('shows a graceful broken-image state when the thumbnail fails', () => {
    renderFrame(<BoardingPassFrame slot="paperBoardingPassFront" flightId="f-1" resourcePath="obj/gone.png" layout={undefined} />);
    const img = screen.getByAltText(/paper front/i);
    fireEvent.error(img);
    expect(screen.queryByAltText(/paper front/i)).toBeNull();
    expect(screen.getByRole('img', { name: /image unavailable/i })).not.toBeNull();
  });
});
