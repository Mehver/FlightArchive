// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Black-box characterization of BoardingPassFrame's presentation contract:
 * absent slots show a deliberate placeholder, bound-but-layout-less slots
 * show a bounded browser thumbnail behind an "unprepared scan" badge, and prepared
 * slots compose the persisted template + placement geometry with the
  * browser-rendered upright rectangular crop.
 * Prepared and unprepared raster previews come from the thumbnail relay — never the original route.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PaperBoardingPassLayout } from '../api/types';
import { LanguageProvider } from '../i18n';

const { mockUseBrowserImage } = vi.hoisted(() => ({ mockUseBrowserImage: vi.fn() }));

vi.mock('../resources/useBrowserImage', () => ({
  useBrowserImage: mockUseBrowserImage.mockImplementation((path: string | null, options?: { crop?: unknown }) => path?.includes('gone')
    ? { status: 'failed', src: null }
    : { status: 'ready', src: options?.crop ? `blob:crop-${path}` : `blob:thumbnail-${path}`, original: false }),
}));

import { BoardingPassFrame } from './BoardingPassFrame';

afterEach(() => { cleanup(); mockUseBrowserImage.mockClear(); });

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
    const { container } = renderFrame(<BoardingPassFrame slot="paperBoardingPassFront" resourcePath={null} layout={undefined} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: /paper front/i })).not.toBeNull();
  });

  it('shows the browser-rendered bound scan with an unprepared badge', () => {
    renderFrame(<BoardingPassFrame slot="paperBoardingPassBack" resourcePath="obj/scan.png" layout={undefined} />);
    const img = screen.getByAltText(/paper back/i);
    expect(img.getAttribute('src')).toBe('blob:thumbnail-obj/scan.png');
    expect(screen.getByText(/unprepared scan/i)).not.toBeNull();
  });

  it('composes template backing and the browser-rendered crop for a prepared slot', () => {
    const { container } = renderFrame(
      <BoardingPassFrame slot="paperBoardingPassFront" resourcePath="obj/scan.png" layout={LAYOUT} />,
    );
    const images = Array.from(container.querySelectorAll('img'));
    // Template artwork (aria-hidden) plus the browser-rendered crop.
    expect(images.length).toBe(2);
    expect(images.some((img) => img.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(images.some((img) => img.getAttribute('src') === 'blob:crop-obj/scan.png')).toBe(true);
    // Percentage placement geometry itself is covered by passPresentation.test.
    expect(screen.queryByText(/unprepared scan/i)).toBeNull();
  });

  it('falls back to the honest unprepared presentation for unusable persisted geometry', () => {
    const brokenLayout: PaperBoardingPassLayout = { ...LAYOUT, crop: { ...LAYOUT.crop, width: 0 } };
    renderFrame(<BoardingPassFrame slot="paperBoardingPassFront" resourcePath="obj/scan.png" layout={brokenLayout} />);
    expect(screen.getByText(/unprepared scan/i)).not.toBeNull();
  });



  it('passes an explicit preview dimension through to prepared rendering', () => {
    renderFrame(<BoardingPassFrame slot="paperBoardingPassFront" resourcePath="obj/scan.png" layout={LAYOUT} maxDimension={128} />);
    expect(mockUseBrowserImage).toHaveBeenCalledWith('obj/scan.png', expect.objectContaining({ maxDimension: 128 }));
  });

  it('shows a graceful broken-image state when the thumbnail fails', () => {
    renderFrame(<BoardingPassFrame slot="paperBoardingPassFront" resourcePath="obj/gone.png" layout={undefined} />);
    expect(screen.queryByAltText(/paper front/i)).toBeNull();
    expect(screen.getByRole('img', { name: /image unavailable/i })).not.toBeNull();
  });
});
