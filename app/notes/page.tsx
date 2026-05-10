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
    <div className="page" style={{ maxWidth: 720, margin: '0 auto', padding: '40px 28px 80px' }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogLd) }}
      />

      <div className="section-header">
        <h2>Notes</h2>
        <div className="count">{notes.length} post{notes.length !== 1 ? 's' : ''}</div>
      </div>
      <p style={{ fontSize: '13.5px', color: 'var(--muted)', marginBottom: 28, lineHeight: 1.7 }}>
        AI in production, not in pitches. Short, opinionated notes from the senior-engineer side of AI/ML.
      </p>

      {notes.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>Nothing here yet.</p>
      ) : (
        <div>
          {notes.map(({ slug, meta }) => (
            <div key={slug} className="card reveal">
              <div className="meta">{formatDate(meta.datePublished)}</div>
              <Link
                href={`/notes/${slug}/`}
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <h3 style={{ fontSize: 20 }}>{meta.title}</h3>
              </Link>
              <p>{meta.description}</p>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 40 }}>
        <SubscribeForm variant="panel" />
      </div>
    </div>
  );
}
