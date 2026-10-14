// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rasterWork: vi.fn(), rasterDisabled: vi.fn() }));
vi.mock('../resources/useBrowserImage', () => ({
  useBrowserImage: (path: string, options: { enabled?: boolean } = {}) => {
    const svg = path.endsWith('.svg');
    if (!svg && options.enabled !== false) mocks.rasterWork(path);
    if (!svg && options.enabled === false) mocks.rasterDisabled(path);
    return svg || options.enabled !== false
      ? { status: 'ready', src: svg ? `/res/${path}` : `blob:rendered-${path}` }
      : { status: 'loading', src: null };
  },
}));
vi.mock('../i18n', () => ({ useTranslation: () => ({ t: () => 'Loading…' }) }));
import { AirlineHorizontalLogo, AirlineLogo } from './AirlineLogo';

afterEach(() => { cleanup(); mocks.rasterWork.mockReset(); mocks.rasterDisabled.mockReset(); vi.unstubAllGlobals(); });

describe('AirlineLogo', () => {
  it('shows the unadorned symbol resource and falls back to the application-colour missing mark', () => {
    render(<AirlineLogo symbolLogoResourcePath="objects/symbol.svg" code="SF" label="Example Air" width={40} height={40} />);
    const logo = screen.getByRole('img', { name: 'Example Air' });
    const image = logo.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/res/objects/symbol.svg');
    fireEvent.error(image);
    expect(logo.textContent).toBe('SF');
    expect(logo.querySelector('img')).toBeNull();
  });

  it('uses a missing mark only when no symbol resource exists', () => {
    render(<AirlineLogo symbolLogoResourcePath={null} code="SF" label="Example Air" width={40} height={40} />);
    expect(screen.getByRole('img', { name: 'Example Air' }).textContent).toBe('SF');
  });

  it('fits a symbol into the host’s inscribed square and serves raster marks through the image route', () => {
    const { container } = render(<AirlineLogo symbolLogoResourcePath="objects/symbol.png" code="SF" label="Example Air" width={60} height={40} />);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('blob:rendered-objects/symbol.png');
    expect(getComputedStyle(image).width).toBe('40px');
    expect(getComputedStyle(image).height).toBe('40px');
    expect(getComputedStyle(image).objectFit).toBe('contain');
    const host = image.closest('[role="img"]') as HTMLElement;
    const loading = screen.getByTestId('image-loading-indicator-host');
    expect(getComputedStyle(host).position).toBe('relative');
    expect(getComputedStyle(loading).position).toBe('absolute');
    expect(getComputedStyle(loading).inset).toBe('0px');
  });

  it.each(['objects/banner.png', 'objects/banner.webp'])('marks the horizontal raster %s inactive after viewport exit', async (path) => {
    const callbacks: IntersectionObserverCallback[] = [];
    const observed: Element[] = [];
    class Observer {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe(element: Element) { observed.push(element); }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '0px';
      thresholds = [0];
    }
    vi.stubGlobal('IntersectionObserver', Observer);

    const { container } = render(<AirlineHorizontalLogo horizontalLogoResourcePath={path} horizontalDarkLogoResourcePath={null} label="Example Air" maxWidth={220} maxHeight={42} />);
    await waitFor(() => expect(callbacks).toHaveLength(1));
    expect(observed).toHaveLength(1);
    expect(getComputedStyle(observed[0] as HTMLElement).width).toBe('220px');
    expect(getComputedStyle(observed[0] as HTMLElement).height).toBe('42px');
    expect(mocks.rasterWork).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();

    await act(async () => callbacks[0]([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(mocks.rasterWork).toHaveBeenCalledWith(path);
    expect(screen.getByAltText('Example Air').getAttribute('src')).toBe(`blob:rendered-${path}`);

    mocks.rasterWork.mockClear();
    mocks.rasterDisabled.mockClear();
    await act(async () => callbacks[0]([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(mocks.rasterWork).not.toHaveBeenCalled();
    expect(mocks.rasterDisabled).toHaveBeenCalledWith(path);
    // This component-level hook mock reports loading while disabled; URL
    // retention itself is covered by useBrowserImage's lifecycle tests.
    expect(container.querySelector('img')).toBeNull();
  });

  it('keeps a stable observed horizontal-logo host when its source appears later', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    const observed: Element[] = [];
    class Observer {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe(element: Element) { observed.push(element); }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '0px';
      thresholds = [0];
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    const view = render(<AirlineHorizontalLogo horizontalLogoResourcePath={null} horizontalDarkLogoResourcePath={null} label="Example Air" />);
    await waitFor(() => expect(observed).toHaveLength(1));
    const host = observed[0];
    view.rerender(<AirlineHorizontalLogo horizontalLogoResourcePath="objects/banner.png" horizontalDarkLogoResourcePath={null} label="Example Air" />);
    expect(observed).toEqual([host]);
    expect(mocks.rasterWork).not.toHaveBeenCalled();
    await act(async () => callbacks[0]([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(mocks.rasterWork).toHaveBeenCalledWith('objects/banner.png');
  });

  it('selects the current theme banner and falls back to the other banner', () => {
    render(<ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}><AirlineHorizontalLogo horizontalLogoResourcePath="objects/light.svg" horizontalDarkLogoResourcePath="objects/dark.svg" label="Example Air" /></ThemeProvider>);
    const image = screen.getByAltText('Example Air');
    expect(image.getAttribute('src')).toBe('/res/objects/dark.svg');
    fireEvent.error(image);
    expect(screen.getByAltText('Example Air').getAttribute('src')).toBe('/res/objects/light.svg');
  });

  it('uses the only available horizontal logo regardless of theme', () => {
    render(<ThemeProvider theme={createTheme({ palette: { mode: 'dark' }})}><AirlineHorizontalLogo horizontalLogoResourcePath="objects/light.svg" horizontalDarkLogoResourcePath={null} label="Example Air" /></ThemeProvider>);
    expect(screen.getByAltText('Example Air').getAttribute('src')).toBe('/res/objects/light.svg');
  });

  it('switches horizontal resources immediately when the application theme changes', () => {
    const { rerender } = render(<ThemeProvider theme={createTheme({ palette: { mode: 'light' } })}><AirlineHorizontalLogo horizontalLogoResourcePath="objects/light.svg" horizontalDarkLogoResourcePath="objects/dark.svg" label="Example Air" /></ThemeProvider>);
    expect(screen.getByAltText('Example Air').getAttribute('src')).toBe('/res/objects/light.svg');
    rerender(<ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}><AirlineHorizontalLogo horizontalLogoResourcePath="objects/light.svg" horizontalDarkLogoResourcePath="objects/dark.svg" label="Example Air" /></ThemeProvider>);
    expect(screen.getByAltText('Example Air').getAttribute('src')).toBe('/res/objects/dark.svg');
  });
});
