// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Black-box characterization of ResourceImage's routing contract: raster
 * resources are served from the cached thumbnail route first, SVG paths go
 * straight to the original route (the thumbnail pipeline does not support
 * SVG), and a failed raster render shows the broken-image placeholder
 * instead of falling back to a potentially huge original. Assertions only
 * touch the rendered DOM (img presence and src), never component internals.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ResourceImage } from './ResourceImage';

// Vitest runs without globals, so testing-library's automatic cleanup is
// not registered; unmount every render explicitly between tests.
afterEach(cleanup);

function renderedImg(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('img');
}

describe('ResourceImage', () => {
  it('serves raster resources from the thumbnail route first', () => {
    render(<ResourceImage resourcePath="inbox/ticket.png" alt="ticket" />);
    const img = screen.getByAltText('ticket');
    expect(img.getAttribute('src')).toBe('/images/inbox/ticket.png');
  });

  it('encodes virtual path segments in the thumbnail URL', () => {
    render(<ResourceImage resourcePath="inbox/my ticket #1.png" alt="ticket" />);
    expect(screen.getByAltText('ticket').getAttribute('src')).toBe('/images/inbox/my%20ticket%20%231.png');
  });

  it('serves SVG resources from the original route directly', () => {
    render(<ResourceImage resourcePath="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg" alt="pass" />);
    expect(screen.getByAltText('pass').getAttribute('src')).toBe(
      '/res/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg',
    );
  });

  it('treats the SVG extension case-insensitively', () => {
    render(<ResourceImage resourcePath="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.SVG" alt="logo" />);
    expect(screen.getByAltText('logo').getAttribute('src')).toBe('/res/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.SVG');
  });

  it('shows the broken-image placeholder on raster failure instead of falling back to the original', () => {
    const { container } = render(<ResourceImage resourcePath="inbox/huge.tiff" alt="scan" />);
    const img = screen.getByAltText('scan');
    expect(img.getAttribute('src')).toBe('/images/inbox/huge.tiff');
    fireEvent.error(img);
    // No <img> remains at all: the original route is never used for rasters.
    expect(screen.queryByAltText('scan')).toBeNull();
    expect(renderedImg(container)).toBeNull();
    expect(container.firstChild).not.toBeNull();
  });

  it('shows the broken-image placeholder when even an SVG original fails', () => {
    const { container } = render(<ResourceImage resourcePath="inbox/icon.svg" alt="icon" />);
    fireEvent.error(screen.getByAltText('icon'));
    expect(renderedImg(container)).toBeNull();
    expect(container.firstChild).not.toBeNull();
  });

  it('re-evaluates the route when the resource path changes', () => {
    const { rerender } = render(<ResourceImage resourcePath="inbox/ticket.png" alt="resource" />);
    expect(screen.getByAltText('resource').getAttribute('src')).toBe('/images/inbox/ticket.png');
    rerender(<ResourceImage resourcePath="inbox/vector.svg" alt="resource" />);
    expect(screen.getByAltText('resource').getAttribute('src')).toBe('/res/inbox/vector.svg');
    rerender(<ResourceImage resourcePath="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.jpg" alt="resource" />);
    expect(screen.getByAltText('resource').getAttribute('src')).toBe('/images/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.jpg');
  });

  it('recovers from a failed render when a different resource path arrives', () => {
    const { container, rerender } = render(<ResourceImage resourcePath="inbox/broken.png" alt="resource" />);
    fireEvent.error(screen.getByAltText('resource'));
    expect(renderedImg(container)).toBeNull();
    rerender(<ResourceImage resourcePath="inbox/working.png" alt="resource" />);
    expect(screen.getByAltText('resource').getAttribute('src')).toBe('/images/inbox/working.png');
  });
});
