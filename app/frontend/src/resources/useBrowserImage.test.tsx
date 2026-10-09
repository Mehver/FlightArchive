// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ render: vi.fn(), release: vi.fn() }));
vi.mock('./browserImageRenderer', async (original) => ({ ...await original<typeof import('./browserImageRenderer')>(), browserImageRenderer: { render: mocks.render, release: mocks.release } }));
import { useBrowserImage } from './useBrowserImage';
import { useNearViewport } from './useNearViewport';

function Probe({ path, enabled = true, centerX = 10 }: { path: string; enabled?: boolean; centerX?: number }) {
  const image = useBrowserImage(path, { crop: { centerX, centerY: 10, width: 10, height: 10, rotationDegrees: 0 }, enabled });
  return <output data-error={image.status === 'failed' ? String(image.error) : ''}>{image.src ?? image.status}</output>;
}
afterEach(() => { cleanup(); mocks.render.mockReset(); mocks.release.mockReset(); vi.unstubAllGlobals(); });

describe('useBrowserImage', () => {
  it('fails closed instead of exposing /res after any raster display failure', async () => {
    mocks.render.mockRejectedValueOnce(new Error('canvas-encode-failed')); render(<Probe path="objects/scan.jpg" />);
    await waitFor(() => expect(screen.getByText('failed')).toBeTruthy());
    expect(document.body.textContent).not.toContain('/res/');
  });

  it('does no raster work while disabled and starts when enabled', async () => {
    mocks.render.mockResolvedValue({ url: 'blob:small', width: 1, height: 1, type: 'image/webp' });
    const view = render(<Probe path="objects/scan.jpg" enabled={false} />); expect(mocks.render).not.toHaveBeenCalled();
    view.rerender(<Probe path="objects/scan.jpg" enabled />); await waitFor(() => expect(screen.getByText('blob:small')).toBeTruthy());
    expect(mocks.render).toHaveBeenCalledOnce();
  });

  it('keeps SVG direct even while raster work is disabled', () => {
    render(<Probe path="objects/logo.svg" enabled={false} />);
    expect(screen.getByText('/res/objects/logo.svg')).toBeTruthy();
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('releases a late result after a path change', async () => {
    let finish!: (value: { url: string; width: number; height: number; type: string }) => void;
    mocks.render.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce({ url: 'blob:new', width: 1, height: 1, type: 'image/webp' });
    const view = render(<Probe path="old.jpg" />); view.rerender(<Probe path="new.jpg" />);
    await waitFor(() => expect(screen.getByText('blob:new')).toBeTruthy()); await act(async () => finish({ url: 'blob:stale', width: 1, height: 1, type: 'image/webp' }));
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:stale' }));
  });

  it('releases the held URL and rerenders when crop geometry changes', async () => {
    mocks.render.mockResolvedValueOnce({ url: 'blob:first-crop', width: 1, height: 1, type: 'image/webp' }).mockResolvedValueOnce({ url: 'blob:second-crop', width: 1, height: 1, type: 'image/webp' });
    const view = render(<Probe path="crop.jpg" />);
    await waitFor(() => expect(screen.getByText('blob:first-crop')).toBeTruthy());
    view.rerender(<Probe path="crop.jpg" centerX={12} />);
    await waitFor(() => expect(screen.getByText('blob:second-crop')).toBeTruthy());
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:first-crop' }));
  });

  it('survives StrictMode cancellation and releases both consumer URLs', async () => {
    mocks.render.mockResolvedValueOnce({ url: 'blob:first', width: 1, height: 1, type: 'image/webp' }).mockResolvedValueOnce({ url: 'blob:second', width: 1, height: 1, type: 'image/webp' });
    const view = render(<StrictMode><Probe path="strict.jpg" /></StrictMode>); await waitFor(() => expect(screen.getByText('blob:second')).toBeTruthy());
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:first' })); view.unmount(); expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:second' }));
  });
});

describe('near-viewport request gate', () => {
  it('does not request any of 92 below-viewport rasters until visibility triggers', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    class Observer { constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); } observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } root = null; rootMargin = '250px 0px'; thresholds = [0]; }
    vi.stubGlobal('IntersectionObserver', Observer);
    mocks.render.mockResolvedValue({ url: 'blob:visible', width: 1, height: 1, type: 'image/webp' });
    function Lazy({ index }: { index: number }) { const visibility = useNearViewport<HTMLDivElement>(); const image = useBrowserImage(`item-${index}.jpg`, { enabled: visibility.enabled }); return <div ref={visibility.ref}>{image.status}</div>; }
    render(<>{Array.from({ length: 92 }, (_, index) => <Lazy key={index} index={index} />)}</>);
    await waitFor(() => expect(callbacks).toHaveLength(92)); expect(mocks.render).not.toHaveBeenCalled();
    await act(async () => callbacks[0]([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
  });

  it('stays enabled after first intersection so exit and re-entry do not rerender or release', async () => {
    let callback!: IntersectionObserverCallback;
    class Observer { constructor(next: IntersectionObserverCallback) { callback = next; } observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } root = null; rootMargin = '250px 0px'; thresholds = [0]; }
    vi.stubGlobal('IntersectionObserver', Observer);
    mocks.render.mockResolvedValue({ url: 'blob:sticky', width: 1, height: 1, type: 'image/webp' });
    function Lazy() { const visibility = useNearViewport<HTMLDivElement>(); const image = useBrowserImage('sticky.jpg', { enabled: visibility.enabled }); return <div ref={visibility.ref}>{image.src ?? image.status}</div>; }
    const view = render(<Lazy />);
    await act(async () => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(screen.getByText('blob:sticky')).toBeTruthy());
    await act(async () => callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    await act(async () => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
    view.unmount();
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:sticky' }));
  });
});
