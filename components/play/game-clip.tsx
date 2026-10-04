'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { PlayMedia } from '@/content/play';
import { cn } from '@/lib/utils';

// A looping, muted game clip over its poster. Each clip loads only when it nears the viewport,
// pauses off screen and in hidden tabs, and never exists under reduced motion. Theme variants are
// separate layers hidden with .only-dark/.only-light: a display:none layer never intersects, so it
// never downloads.

const REDUCED = '(prefers-reduced-motion: reduce)';

function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia?.(REDUCED);
  mq?.addEventListener('change', onChange);
  return () => mq?.removeEventListener('change', onChange);
}

function useReducedMotion() {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia?.(REDUCED).matches ?? false,
    () => false,
  );
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

function usePageHidden() {
  return useSyncExternalStore(subscribeVisibility, () => document.hidden, () => false);
}

function ClipLayer({
  media,
  paused,
  reduced,
  onBlocked,
  className,
}: {
  media: PlayMedia;
  paused: boolean;
  reduced: boolean;
  onBlocked: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hidden = usePageHidden();
  const [inView, setInView] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    // Entries can arrive batched (in and out before the callback runs): the last one is current.
    const io = new IntersectionObserver((entries) => setInView(entries[entries.length - 1].isIntersecting), {
      rootMargin: '200px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  const run = !reduced && inView && !paused && !hidden;

  useEffect(() => {
    if (run) setLoaded(true);
  }, [run]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !loaded) return;
    if (run) {
      // Refused autoplay (Low Power Mode, data saver) leaves the poster up and flips the toggle to
      // "Play video", so one tap starts the clip. AbortError is just a pause() interrupting play().
      v.play().catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'NotAllowedError') onBlocked();
      });
    } else {
      v.pause();
    }
  }, [run, loaded, onBlocked]);

  return (
    <div ref={ref} className={cn('play-clip-layer', className)}>
      <img
        className="play-clip-poster"
        src={media.poster}
        alt={media.alt}
        width={1600}
        height={1000}
        loading="lazy"
        decoding="async"
      />
      {!reduced && (
        <video
          ref={videoRef}
          className={cn('play-clip-video', playing && 'is-playing')}
          src={loaded ? media.video : undefined}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
          tabIndex={-1}
          onPlaying={() => setPlaying(true)}
        />
      )}
    </div>
  );
}

export function GameClip({
  media,
  lightMedia,
  className,
  children,
}: {
  media: PlayMedia;
  lightMedia?: PlayMedia;
  className?: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const onBlocked = useCallback(() => setPaused(true), []);

  return (
    <div className={cn('play-clip', className)}>
      {lightMedia ? (
        <>
          <ClipLayer media={media} paused={paused} reduced={reduced} onBlocked={onBlocked} className="only-dark" />
          <ClipLayer media={lightMedia} paused={paused} reduced={reduced} onBlocked={onBlocked} className="only-light" />
        </>
      ) : (
        <ClipLayer media={media} paused={paused} reduced={reduced} onBlocked={onBlocked} />
      )}
      {children}
      {!reduced && (
        <button
          type="button"
          className="play-clip-toggle"
          aria-label={paused ? 'Play video' : 'Pause video'}
          onClick={() => setPaused((p) => !p)}
        >
          <span aria-hidden="true">{paused ? '▶' : '❚❚'}</span>
        </button>
      )}
    </div>
  );
}
