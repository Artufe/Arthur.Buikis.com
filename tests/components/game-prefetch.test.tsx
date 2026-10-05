import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { installMediaMocks, setInView } from '../helpers/media-mocks';

const prefetchLittlebig = vi.fn();
vi.mock('@/components/littlebig/littlebig-window-host', () => ({ prefetchLittlebig: () => prefetchLittlebig() }));

import { GamePrefetch } from '@/components/play/game-prefetch';

beforeEach(() => {
  installMediaMocks();
  prefetchLittlebig.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GamePrefetch', () => {
  it('warms the LITTLEBIG engine after its card is in view and its clip has a frame, and only once', () => {
    const { container } = render(
      <div data-testid="card">
        <GamePrefetch slug="littlebig" />
        <video />
      </div>,
    );
    const card = container.firstElementChild!;
    vi.advanceTimersByTime(5000);
    expect(prefetchLittlebig).not.toHaveBeenCalled();
    setInView(card, true);
    vi.advanceTimersByTime(1000);
    expect(prefetchLittlebig).not.toHaveBeenCalled(); // behind the clip, not ahead of it
    card.querySelector('video')!.dispatchEvent(new Event('loadeddata')); // doesn't bubble: capture
    vi.advanceTimersByTime(2500);
    expect(prefetchLittlebig).toHaveBeenCalledTimes(1);
    setInView(card, false);
    setInView(card, true);
    vi.advanceTimersByTime(5000);
    expect(prefetchLittlebig).toHaveBeenCalledTimes(1);
  });

  it('still warms it when the card never plays a clip (reduced motion, refused autoplay)', () => {
    const { container } = render(
      <div>
        <GamePrefetch slug="littlebig" />
      </div>,
    );
    setInView(container.firstElementChild!, true);
    vi.advanceTimersByTime(6000);
    expect(prefetchLittlebig).toHaveBeenCalledTimes(1);
  });
});
