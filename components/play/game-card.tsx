import Link from 'next/link';
import type { PlayGame } from '@/content/play';
import { GameClip } from '@/components/play/game-clip';
import { GamePrefetch } from '@/components/play/game-prefetch';
import { cn } from '@/lib/utils';

export function GameCard({ game, index }: { game: PlayGame; index: number }) {
  return (
    // An odd last card spans the grid at lg as a landscape card (clip left, copy and receipt right):
    // see .play-grid in globals.css. The side copy shows only there.
    <article className="play-game min-w-0">
      <GamePrefetch slug={game.slug} />
      <div className="play-game-idx">
        <span>
          <b>{String(index + 1).padStart(2, '0')}</b> · {game.slug}
        </span>
        <span>
          pr #{game.pr.number} · {game.pr.date}
        </span>
      </div>

      <GameClip media={game.media} lightMedia={game.lightMedia} className="play-card">
        {/* aria-label replaces the link's content, so describedby restores the requirements and the
            description for screen readers. */}
        <Link
          href={game.href}
          className="play-card-link"
          aria-label={`Play ${game.title}`}
          aria-describedby={`play-${game.slug}-req play-${game.slug}-desc`}
        >
          <span className={cn('play-chip', `play-chip--${game.chip.tone}`)}>
            <i aria-hidden="true">●</i>
            <span id={`play-${game.slug}-req`} className="play-chip-full">
              {game.chip.label}
            </span>
            <span className="play-chip-short" aria-hidden="true">
              {game.chip.short ?? game.chip.label}
            </span>
          </span>
          <span className="play-ov">
            <span className="play-ov-cmd" aria-hidden="true">
              <b>$</b>
              {game.cmd}
            </span>
            <span className="play-ov-title">{game.title}</span>
            <span id={`play-${game.slug}-desc`} className="play-ov-desc">
              {game.description}
            </span>
            <span className="play-ov-go">
              <span className="play-ov-path">{game.href.replace(/\/$/, '')}</span>
              <span className="play-ov-btn">
                <span className="play-ov-btn-desk">▶ play</span>
                <span className="play-ov-btn-touch">▶ {game.touchCta}</span>
              </span>
            </span>
          </span>
        </Link>
      </GameClip>

      <div className="play-game-side" aria-hidden="true">
        <p className="play-game-side-title">{game.title}</p>
        <p className="play-game-side-desc">{game.description}</p>
      </div>

      <dl className="play-receipt">
        {game.receipt.map((row) => (
          <div key={row.label} className={row.desktopOnly ? 'play-receipt-desk' : undefined}>
            <dt>{row.label}</dt>
            <dd>
              {row.href ? (
                <a href={row.href} target="_blank" rel="noreferrer">
                  {row.value}
                </a>
              ) : (
                row.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
