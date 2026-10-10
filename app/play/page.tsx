import type { Metadata } from 'next';
import { ogImage } from '@/lib/og';
import { games } from '@/content/play';
import { GameCard } from '@/components/play/game-card';
import { PlayMethod } from '@/components/play/play-method';

const title = 'Play';
const description =
  'Three browser games built with coding agents: a tiny planet built by a harness of agents, an orchestrated WebGPU surf demo and a one-shot 3D snake, and how each was built.';
const path = '/play/';

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: path },
  openGraph: { type: 'website', title, description, url: path, images: [ogImage] },
  twitter: { card: 'summary_large_image', title, description },
};

export default function PlayPage() {
  return (
    <>
      <section className="mx-auto max-w-[1600px] px-6 pt-20 pb-14 lg:px-16 lg:pt-28 lg:pb-20">
        <div className="font-mono text-[12px] text-[var(--muted)] tracking-wide" aria-hidden>
          <span className="text-[var(--accent)] mr-2">$</span>ls -la ~/play
        </div>
        <h1 className="play-h1 mt-5">Three games, built with agents.</h1>
        <p className="mt-7 max-w-[60ch] font-mono text-[13px] leading-[1.75] text-[var(--muted)]">
          All three run right here in the browser.{' '}
          <span className="text-[var(--fg)]">Claude Opus 5.5 wrote the code.</span> I wrote the prompts, chose
          what to focus on and reviewed the results. For GOLDENLINE I split the work into agent tasks;
          LITTLEBIG&rsquo;s orchestrator did that itself.
        </p>
      </section>

      <section
        aria-label="Games"
        className="play-grid mx-auto grid max-w-[1600px] gap-10 px-6 pb-20 lg:grid-cols-2 lg:px-16 lg:pb-28"
      >
        {games.map((game, i) => (
          <GameCard key={game.slug} game={game} index={i} />
        ))}
      </section>

      <PlayMethod />
    </>
  );
}
