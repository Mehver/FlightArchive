// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageLoadingIndicator, IMAGE_LOADING_INDICATOR_DELAY_MS, imageLoadingIndicatorSize } from './ImageLoadingIndicator';

describe('ImageLoadingIndicator', () => {
  let callbacks: ResizeObserverCallback[];
  let disconnects: ReturnType<typeof vi.fn>[];

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('scales against the shorter host edge and stays within compact bounds', () => {
    expect(imageLoadingIndicatorSize(58, 23)).toBe(12);
    expect(imageLoadingIndicatorSize(40, 40)).toBe(20);
    expect(imageLoadingIndicatorSize(500, 100)).toBe(24);
  });

  it('does not flash for a fast ready image', () => {
    const view = render(<ImageLoadingIndicator loading label="Loading" />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    view.rerender(<ImageLoadingIndicator loading={false} label="Loading" />);
    act(() => vi.advanceTimersByTime(IMAGE_LOADING_INDICATOR_DELAY_MS));
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('does not measure or observe while it is not loading', () => {
    const observe = vi.fn();
    const construct = vi.fn();
    class Observer {
      constructor() { construct(); }
      observe = observe;
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', Observer);

    render(<ImageLoadingIndicator loading={false} label="Loading" />);
    expect(construct).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it('starts measuring on false-to-true and disconnects on true-to-false', () => {
    callbacks = [];
    disconnects = [];
    class Observer {
      disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
        disconnects.push(this.disconnect);
      }
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', Observer);

    const view = render(<ImageLoadingIndicator loading={false} label="Loading" />);
    expect(callbacks).toHaveLength(0);
    view.rerender(<ImageLoadingIndicator loading label="Loading" />);
    expect(callbacks).toHaveLength(1);
    act(() => callbacks[0]([{ contentRect: { width: 40, height: 40 } } as ResizeObserverEntry], {} as ResizeObserver));
    act(() => vi.advanceTimersByTime(IMAGE_LOADING_INDICATOR_DELAY_MS));
    expect(screen.getByRole('progressbar').getAttribute('style')).toContain('width: 20px');

    view.rerender(<ImageLoadingIndicator loading={false} label="Loading" />);
    expect(disconnects[0]).toHaveBeenCalledOnce();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows delayed slow loading, responds to resize, and cleans up on unmount', () => {
    let callback: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    class Observer {
      constructor(next: ResizeObserverCallback) { callback = next; }
      observe() {}
      unobserve() {}
      disconnect() { disconnect(); }
    }
    vi.stubGlobal('ResizeObserver', Observer);

    const view = render(<ImageLoadingIndicator loading label="Loading" />);
    act(() => {
      callback?.([{ contentRect: { width: 58, height: 23 } } as ResizeObserverEntry], {} as ResizeObserver);
      vi.advanceTimersByTime(IMAGE_LOADING_INDICATOR_DELAY_MS);
    });
    expect(screen.getByRole('progressbar', { name: 'Loading' }).getAttribute('style')).toContain('width: 12px');
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
