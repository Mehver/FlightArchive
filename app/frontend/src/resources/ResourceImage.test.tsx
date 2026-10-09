// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('./useBrowserImage', () => ({
  useBrowserImage: (path: string) => path.includes('broken')
    ? { status: 'failed', src: null }
    : path.includes('loading') ? { status: 'loading', src: null } : { status: 'ready', src: path.endsWith('.svg') ? `/res/${path}` : `blob:rendered-${path}` },
}));
vi.mock('../i18n', () => ({ useTranslation: () => ({ t: () => 'Loading…' }) }));

import { ResourceImage } from './ResourceImage';

afterEach(cleanup);

describe('ResourceImage', () => {
  it('shows loading until the produced raster element loads', () => {
    render(<ResourceImage resourcePath="inbox/ticket.png" alt="ticket" />);
    const element = screen.getByAltText('ticket');
    expect(element.getAttribute('src')).toBe('blob:rendered-inbox/ticket.png');
    expect(screen.getByRole('progressbar', { name: /loading/i })).toBeTruthy();
    fireEvent.load(element);
    expect(screen.queryByRole('progressbar', { name: /loading/i })).toBeNull();
  });

  it('keeps SVG resources on the direct original route', () => {
    render(<ResourceImage resourcePath="objects/logo.svg" alt="logo" />);
    const element = screen.getByAltText('logo');
    expect(element.getAttribute('src')).toBe('/res/objects/logo.svg');
    expect(screen.getByRole('progressbar', { name: /loading/i })).toBeTruthy();
    fireEvent.load(element);
    expect(screen.queryByRole('progressbar', { name: /loading/i })).toBeNull();
  });

  it('uses the same bounded placeholder geometry while loading and on failure', () => {
    const { rerender, container } = render(<ResourceImage resourcePath="loading.png" alt="scan" size={44} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'scan' })).toBeTruthy();
    rerender(<ResourceImage resourcePath="broken.png" alt="scan" size={44} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('re-evaluates browser output when the resource changes', () => {
    const { rerender } = render(<ResourceImage resourcePath="first.png" alt="resource" />);
    expect(screen.getByAltText('resource').getAttribute('src')).toBe('blob:rendered-first.png');
    rerender(<ResourceImage resourcePath="second.png" alt="resource" />);
    expect(screen.getByAltText('resource').getAttribute('src')).toBe('blob:rendered-second.png');
  });
});
