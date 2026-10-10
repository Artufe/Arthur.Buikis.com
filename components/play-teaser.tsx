import Link from 'next/link';
import { ScrollReveal } from '@/components/scroll-reveal';
import { GameClip } from '@/components/play/game-clip';
import { GamePrefetch } from '@/components/play/game-prefetch';
import { games } from '@/content/play';

export function PlayTeaser() {
  return (
    <section
      id="play"
      className="mx-auto max-w-[1600px] px-6 py-20 lg:px-16 lg:py-28"
      style={{ borderTop: '2px solid var(--border)' }}
    >
      <ScrollReveal>
        <div className="grid gap-14 lg:grid-cols-[1fr_2.5fr]">
          <div>
            <div className="font-mono text-[12px] text-[var(--muted)] tracking-wide" aria-hidden style={{ marginBottom: 14 }}>
              <span className="text-[var(--accent)] mr-2">$</span>ls ~/play
            </div>
            <h2 className="font-display text-[30px] leading-[1.12] tracking-tight" style={{ margin: 0 }}>
              Three games, <br />built with <br />agents.
            </h2>
            <p className="mt-5 max-w-[30ch] font-mono text-[13px] leading-[1.7] dim">
              A tiny planet that a harness of agents built overnight, a two-evening eleven-agent build and a 40-minute one-shot. All three run in your browser.
            </p>
            <p className="mt-5 font-mono text-[10px] dim leading-[1.6]">
              Claude Opus 5.5 · code <br />
              me · prompts, focus, review
            </p>
          </div>

          <div className="min-w-0">
            <div className="grid gap-5 sm:grid-cols-3">
              {games.map((g) => (
                <div key={g.slug} className="min-w-0">
                  <GamePrefetch slug={g.slug} />
                  <GameClip media={g.media} lightMedia={g.lightMedia} className="play-tile">
                    <Link href={g.href} className="play-tile-link" aria-label={`Play ${g.title}`}>
                      <span className="play-tile-badge" aria-hidden="true">
                        ▶ play
                      </span>
                    </Link>
                  </GameClip>
                  <p className="play-tile-cap">
                    {g.caption.map((part, i) => (
                      <span key={part} className={i === 0 ? 'text-[var(--fg)]' : 'dim'}>
                        {part}
                      </span>
                    ))}
                  </p>
                </div>
              ))}
            </div>
            <Link
              href="/play/"
              className="mt-7 block py-5 font-mono text-[11px] dim border-t-2 border-dashed border-[var(--border)] hover:text-[var(--accent)] transition-colors duration-[var(--dur)]"
            >
              [ how they were built · /play → ]
            </Link>
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}
