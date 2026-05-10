import type { Metadata } from 'next';
import Content, { meta } from '@/content/building/index.mdx';

const title = 'Building';
const description = 'What I\'m currently building — status, scope, and how to follow.';
const path = '/building/';

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: path },
  openGraph: {
    type: 'website',
    title,
    description,
    url: path,
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
  },
};

export default function BuildingPage() {
  return (
    <article className="mx-auto max-w-[720px] px-6 py-16 lg:py-24">
      <p className="lbl">Building · Updated {meta.updated}</p>
      <h1 className="mt-4 font-serif text-[clamp(40px,5vw,64px)] leading-[1.02] tracking-tight font-medium">{meta.name}.</h1>
      <p className="mt-4 font-mono text-xs text-[var(--accent)]">status: {meta.status}</p>
      <div className="mt-12 max-w-none">
        <Content />
      </div>
    </article>
  );
}
