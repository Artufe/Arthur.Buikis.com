import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GameClip } from '@/components/play/game-clip';
import type { PlayMedia } from '@/content/play';
import { installMediaMocks, setInView, setReducedMotion } from '../helpers/media-mocks';

const DARK: PlayMedia = { poster: '/play/x-dark.jpg', video: '/play/x-dark.mp4', alt: 'A dark test scene with enough words' };
const LIGHT: PlayMedia = { poster: '/play/x-light.jpg', video: '/play/x-light.mp4', alt: 'A light test scene with enough words' };

let media: ReturnType<typeof installMediaMocks>;
beforeEach(() => {
  media = installMediaMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderClip(props: { lightMedia?: PlayMedia } = {}) {
  const utils = render(
    <GameClip media={DARK} {...props}>
      <a href="/snake/">Play Test</a>
    </GameClip>,
  );
  const layers = [...utils.container.querySelectorAll<HTMLElement>('.play-clip-layer')];
  const videoOf = (layer: Element) => layer.querySelector('video')!;
  return { ...utils, layers, videoOf };
}

describe('GameClip', () => {
  it('loads the clip only in view, and pauses it out of view', () => {
    const { layers, videoOf } = renderClip();
    const v = videoOf(layers[0]);
    expect(v.getAttribute('src')).toBeNull();
    setInView(layers[0], true);
    expect(v.getAttribute('src')).toBe(DARK.video);
    expect(media.played).toContain(v);
    setInView(layers[0], false);
    expect(media.paused).toContain(v);
  });

  it('keeps a manual pause across scrolling, with the toggle outside the link', () => {
    const { layers } = renderClip();
    setInView(layers[0], true);
    const playsAfterLoad = media.played.length;
    const toggle = screen.getByRole('button', { name: 'Pause video' });
    expect(toggle.closest('a')).toBeNull();
    fireEvent.click(toggle);
    setInView(layers[0], false);
    setInView(layers[0], true);
    expect(media.played.length).toBe(playsAfterLoad);
    fireEvent.click(screen.getByRole('button', { name: 'Play video' }));
    expect(media.played.length).toBe(playsAfterLoad + 1);
  });

  it('keeps the poster when autoplay is refused', async () => {
    media.play.mockImplementation(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
    const { layers, videoOf } = renderClip();
    setInView(layers[0], true);
    await act(async () => {});
    expect(videoOf(layers[0]).classList.contains('is-playing')).toBe(false);
    expect(screen.getByAltText(DARK.alt)).toBeDefined();
    // The toggle offers to play, so one tap (a user gesture) starts the clip.
    expect(screen.getByRole('button', { name: 'Play video' })).toBeDefined();
  });

  it('drops the video and toggle when reduced motion turns on', () => {
    const { container, layers } = renderClip();
    setInView(layers[0], true);
    setReducedMotion(true);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByAltText(DARK.alt)).toBeDefined();
  });

  it('plays only the theme variant that is on screen', () => {
    const { layers, videoOf } = renderClip({ lightMedia: LIGHT });
    const [dark, light] = layers;
    expect(dark.classList.contains('only-dark')).toBe(true);
    expect(light.classList.contains('only-light')).toBe(true);
    // A display:none layer never intersects, so only the visible variant loads.
    setInView(light, true);
    expect(videoOf(light).getAttribute('src')).toBe(LIGHT.video);
    expect(videoOf(dark).getAttribute('src')).toBeNull();
  });
});
