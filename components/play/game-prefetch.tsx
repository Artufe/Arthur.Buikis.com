'use client';

import { useEffect, useRef } from 'react';
import type { PlayGame } from '@/content/play';
import { prefetchLittlebig } from '@/components/littlebig/littlebig-window-host';

// Warms a game's engine chunk once its card or tile is in view and its clip has a frame, so
// following the link starts the game without waiting on the download. JS only: worlds and GPU
// state build on open. Deliberately on-view rather than on idle (BRIEF §8 says idle on /play): a
// visitor who never scrolls to the game never downloads its ~165 KB.
const PREFETCH: Partial<Record<PlayGame['slug'], () => void>> = {
  littlebig: prefetchLittlebig,
};

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

export function GamePrefetch({ slug }: { slug: PlayGame['slug'] }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const warm = PREFETCH[slug];
    const target = ref.current?.parentElement;
    if (!warm || !target || typeof IntersectionObserver === 'undefined') return;
    // Respect Data Saver: the game still loads on click.
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;

    const w = window as IdleWindow;
    let cancel = () => {};
    const idle = () => {
      if (w.requestIdleCallback && w.cancelIdleCallback) {
        const id = w.requestIdleCallback(warm, { timeout: 2000 });
        cancel = () => w.cancelIdleCallback!(id);
      } else {
        const id = window.setTimeout(warm, 300);
        cancel = () => window.clearTimeout(id);
      }
    };
    // Behind the card's own clip, not ahead of it: wait for its first frame (media events don't
    // bubble, so listen in the capture phase), or a few seconds when there is no clip (reduced
    // motion, refused autoplay).
    const afterClip = () => {
      const go = () => {
        target.removeEventListener('loadeddata', go, true);
        window.clearTimeout(fallback);
        idle();
      };
      const fallback = window.setTimeout(go, 3000);
      target.addEventListener('loadeddata', go, true);
      cancel = () => {
        target.removeEventListener('loadeddata', go, true);
        window.clearTimeout(fallback);
      };
    };
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      afterClip();
    });
    io.observe(target);
    return () => {
      io.disconnect();
      cancel();
    };
  }, [slug]);

  return <span ref={ref} hidden aria-hidden="true" data-prefetch={slug} />;
}
