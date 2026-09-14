// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material';
import { afterEach, describe, expect, it } from 'vitest';
import { AirlineHorizontalLogo, AirlineLogo } from './AirlineLogo';

afterEach(cleanup);

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
    expect(image.getAttribute('src')).toBe('/images/objects/symbol.png');
    expect(getComputedStyle(image).width).toBe('40px');
    expect(getComputedStyle(image).height).toBe('40px');
    expect(getComputedStyle(image).objectFit).toBe('contain');
  });

  it('selects the current theme banner and falls back to the other banner', () => {
    render(<ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}><AirlineHorizontalLogo horizontalLogoResourcePath="objects/light.svg" horizontalDarkLogoResourcePath="objects/dark.svg" label="Example Air" /></ThemeProvider>);
    const image = screen.getByAltText('Example Air');
    expect(image.getAttribute('src')).toBe('/res/objects/dark.svg');
    fireEvent.error(image);
    expect(image.getAttribute('src')).toBe('/res/objects/light.svg');
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
