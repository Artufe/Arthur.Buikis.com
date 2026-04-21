import type { Metadata } from 'next';
import Content, { meta } from '@/content/building/index.mdx';

export const metadata: Metadata = {
  title: 'Building',
  description: 'What I\'m currently building — status, scope, and how to follow.',
};

export default function BuildingPage() {
  return (
    <article className="mx-auto max-w-[720px] px-6 py-16 lg:py-24">
      <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--fg-muted)]">Building · Updated {meta.updated}</p>
      <h1 className="mt-4 font-serif text-[clamp(40px,5vw,64px)] leading-[1.02] tracking-tight">{meta.name}.</h1>
      <p className="mt-4 font-mono text-xs text-[var(--accent)]">status: {meta.status}</p>
      <div className="mt-12 max-w-none">
        <Content />
      </div>
    </article>
  );
}
