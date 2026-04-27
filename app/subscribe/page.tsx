import type { Metadata } from 'next';
import { SubscribeForm } from '@/components/subscribe-form';

export const metadata: Metadata = {
  title: 'Subscribe',
  description: 'Get every note from Arthur Buikis — AI in production, not in pitches — in your inbox.',
  alternates: { canonical: '/subscribe/' },
};

export default function SubscribePage() {
  return (
    <div className="mx-auto max-w-[720px] px-6 py-16 lg:py-24">
      <p className="lbl">Subscribe</p>
      <h1 className="mt-4 font-serif text-[clamp(36px,5vw,56px)] leading-[1.02] tracking-tight">
        AI in production, not in pitches.
      </h1>
      <p className="mt-4 font-serif italic text-xl text-[var(--fg-muted)] leading-snug">
        Short, opinionated notes from the senior-engineer side of AI/ML — straight to your inbox.
      </p>

      <div className="mt-12">
        <SubscribeForm variant="panel" />
      </div>

      <section className="mt-16 border-t border-[var(--rule)] pt-10">
        <p className="lbl mb-6">What to expect</p>
        <ul className="space-y-4 text-[var(--fg-muted)] leading-relaxed">
          <li>
            <strong className="text-[var(--fg)]">Cadence over polish.</strong> One note a week, give
            or take. Some 200 words, some 2000. Whatever the topic deserves.
          </li>
          <li>
            <strong className="text-[var(--fg)]">No tracking, no drip.</strong> When a note ships,
            you get it. That&apos;s the whole product.
          </li>
          <li>
            <strong className="text-[var(--fg)]">Unsubscribe in one click.</strong> No dark
            patterns, no &quot;are you sure?&quot; popups.
          </li>
        </ul>
      </section>
    </div>
  );
}
