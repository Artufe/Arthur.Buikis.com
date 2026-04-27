import type { Metadata } from 'next';
import Link from 'next/link';
import { getNotesIndex } from '@/lib/notes';
import { site } from '@/content/site';
import { SubscribeForm } from '@/components/subscribe-form';

export const metadata: Metadata = {
  title: 'Notes',
  description: 'AI in production, not in pitches. Short, opinionated notes from the senior-engineer side of AI/ML.',
  alternates: { canonical: '/notes/' },
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default async function NotesIndexPage() {
  const notes = await getNotesIndex();

  const blogLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    '@id': `${site.url}/notes/#blog`,
    url: `${site.url}/notes/`,
    name: `${site.name} · Notes`,
    description: 'AI in production, not in pitches.',
    author: { '@id': `${site.url}/#person` },
    publisher: { '@id': `${site.url}/#person` },
    blogPost: notes.map((n) => ({
      '@type': 'BlogPosting',
      headline: n.meta.title,
      description: n.meta.description,
      url: `${site.url}/notes/${n.slug}/`,
      datePublished: n.meta.datePublished,
    })),
  };

  return (
    <div className="mx-auto max-w-[720px] px-6 py-16 lg:py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogLd) }}
      />

      <p className="lbl">Notes</p>
      <h1 className="mt-4 font-serif text-[clamp(36px,5vw,56px)] leading-[1.02] tracking-tight">
        AI in production, not in pitches.
      </h1>
      <p className="mt-4 font-serif italic text-xl text-[var(--fg-muted)] leading-snug">
        Short, opinionated notes from the senior-engineer side of AI/ML.
      </p>

      {notes.length === 0 ? (
        <p className="mt-16 text-[var(--fg-muted)]">Nothing here yet.</p>
      ) : (
        <ul className="mt-16 divide-y divide-[var(--rule)]">
          {notes.map(({ slug, meta }) => (
            <li key={slug} className="py-8 first:pt-0">
              <Link
                href={`/notes/${slug}/`}
                className="group block transition-colors duration-[var(--dur-fast)]"
              >
                <p className="lbl text-[var(--fg-faint)] group-hover:text-[var(--accent)]">
                  {formatDate(meta.datePublished)}
                </p>
                <h2 className="mt-2 font-serif text-2xl leading-tight group-hover:text-[var(--accent)]">
                  {meta.title}
                </h2>
                <p className="mt-2 text-[var(--fg-muted)] leading-relaxed">{meta.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-20">
        <SubscribeForm variant="panel" />
      </div>
    </div>
  );
}
