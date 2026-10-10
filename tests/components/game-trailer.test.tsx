import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GameTrailer } from '@/components/play/game-trailer';

const trailer = { video: '/t.mp4', poster: '/t.jpg', seconds: 30, chapters: [{ at: 10, label: 'bird flight', thumb: '/c.jpg' }] };

const nativeShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (nativeShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', nativeShowModal);
  else delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal;
});

describe('GameTrailer', () => {
  it('downloads nothing until opened, then plays from the chosen chapter', () => {
    const showModal = vi.fn();
    // jsdom (so far) has no showModal.
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: showModal, configurable: true });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const { container } = render(<GameTrailer title="LITTLEBIG" href="/planet/" trailer={trailer} />);
    const video = container.querySelector('video')!;
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.hasAttribute('poster')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Watch the trailer from 0:10: bird flight' }));
    expect(showModal).toHaveBeenCalledOnce();
    expect(video.currentTime).toBe(10);
    expect(play).toHaveBeenCalledOnce();
    expect(video.getAttribute('poster')).toBe('/t.jpg');
  });
});
