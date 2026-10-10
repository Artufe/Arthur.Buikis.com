'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { PlayTrailer } from '@/content/play';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// A game's trailer: a button and chapter thumbnails under its card, opening a native modal
// <dialog> with the video (sound, controls). Nothing downloads until it opens: preload="none", and
// the poster is set on first open. play() runs inside the click, so Safari allows the sound.
export function GameTrailer({ title, href, trailer }: { title: string; href: string; trailer: PlayTrailer }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [opened, setOpened] = useState(false);

  const open = (at: number) => {
    const d = dialog.current;
    const v = video.current;
    if (!d || !v) return;
    setOpened(true);
    d.showModal();
    v.currentTime = at;
    v.play().catch(() => {});
  };

  return (
    <div className="play-trailer">
      <div className="play-trailer-actions">
        <button type="button" className="play-trailer-btn" onClick={() => open(0)}>
          <span aria-hidden="true">▶</span> watch the trailer{' '}
          <span className="play-trailer-meta">{clock(trailer.seconds)} · sound</span>
        </button>
      </div>
      <ol className="play-trailer-chapters" aria-label={`${title} trailer chapters`}>
        {trailer.chapters.map((c) => (
          <li key={c.at}>
            <button type="button" onClick={() => open(c.at)} aria-label={`Watch the trailer from ${clock(c.at)}: ${c.label}`}>
              <img src={c.thumb} alt="" width={480} height={300} loading="lazy" decoding="async" />
              <span aria-hidden="true">
                {clock(c.at)} · {c.label}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <dialog
        ref={dialog}
        className="play-trailer-dialog"
        aria-label={`${title} trailer`}
        onClose={() => video.current?.pause()}
        // A click on the backdrop lands on the dialog itself; its content is wrapped.
        onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
      >
        <div className="play-trailer-frame">
          <div className="play-trailer-bar">
            <span>
              {title} — trailer · {clock(trailer.seconds)}
            </span>
            <button type="button" onClick={() => dialog.current?.close()} aria-label="Close the trailer">
              ✕ close <span aria-hidden="true">esc</span>
            </button>
          </div>
          <video
            ref={video}
            src={trailer.video}
            poster={opened ? trailer.poster : undefined}
            controls
            playsInline
            preload="none"
            width={1920}
            height={1080}
          />
          <p className="play-trailer-note">
            <span>Every shot is the game itself, rendered in the engine frame by frame.</span>
            <Link href={href}>▶ play {title}</Link>
          </p>
        </div>
      </dialog>
    </div>
  );
}
