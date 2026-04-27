import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { site } from '@/content/site';
import { getNoteSlugs, loadNote, type NoteFAQ, type NoteHowTo } from '@/lib/notes';
import { SubscribeForm } from '@/components/subscribe-form';

export function generateStaticParams() {
  return getNoteSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!getNoteSlugs().includes(slug)) return { title: 'Not found' };
  const { meta } = await loadNote(slug);
  const path = `/notes/${slug}/`;
  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical: path },
    openGraph: {
      type: 'article',
      title: meta.title,
      description: meta.description,
      url: path,
      publishedTime: meta.datePublished,
      authors: [site.name],
      tags: meta.tags,
      images: ['/opengraph-image.png'],
    },
    twitter: {
      card: 'summary_large_image',
      title: meta.title,
      description: meta.description,
    },
  };
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function FAQBlock({ items }: { items: NoteFAQ[] }) {
  return (
    <section className="mt-16 border-t border-[var(--rule-strong)] pt-10">
      <p className="lbl mb-6">FAQ</p>
      <dl className="space-y-6">
        {items.map((item) => (
          <div key={item.q}>
            <dt className="font-serif text-lg leading-snug">{item.q}</dt>
            <dd className="mt-2 text-[var(--fg-muted)] leading-relaxed">{item.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function HowToBlock({ howTo }: { howTo: NoteHowTo }) {
  return (
    <section className="mt-16 border-t border-[var(--rule-strong)] pt-10">
      <p className="lbl mb-6">{howTo.name}</p>
      {howTo.description && (
        <p className="text-[var(--fg-muted)] leading-relaxed mb-6">{howTo.description}</p>
      )}
      <ol className="space-y-5 list-none counter-reset-[step]">
        {howTo.steps.map((step, i) => (
          <li key={step.name} className="flex gap-5">
            <span
              className="font-mono text-[11px] text-[var(--fg-faint)] mt-1 w-6 shrink-0"
              aria-hidden
            >
              {String(i + 1).padStart(2, '0')}
            </span>
            <div>
              <p className="font-serif text-lg leading-snug">{step.name}</p>
              <p className="mt-1 text-[var(--fg-muted)] leading-relaxed">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default async function NoteDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!getNoteSlugs().includes(slug)) notFound();
  const { default: Content, meta } = await loadNote(slug);

  const pageUrl = `${site.url}/notes/${slug}/`;

  const blogPostingLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: meta.title,
    description: meta.description,
    datePublished: meta.datePublished,
    dateModified: meta.datePublished,
    image: {
      '@type': 'ImageObject',
      url: `${site.url}${meta.image ?? '/opengraph-image.png'}`,
      width: 1200,
      height: 630,
    },
    author: { '@id': `${site.url}/#person` },
    publisher: { '@id': `${site.url}/#person` },
    mainEntityOfPage: pageUrl,
    isPartOf: { '@id': `${site.url}/#website` },
    keywords: meta.tags?.join(', '),
  };

  const faqLd = meta.faq && meta.faq.length > 0 ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: meta.faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  } : null;

  const howToLd = meta.howTo ? {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: meta.howTo.name,
    description: meta.howTo.description,
    step: meta.howTo.steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: s.name,
      text: s.text,
    })),
  } : null;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${site.url}/` },
      { '@type': 'ListItem', position: 2, name: 'Notes', item: `${site.url}/notes/` },
      { '@type': 'ListItem', position: 3, name: meta.title, item: pageUrl },
    ],
  };

  return (
    <article className="mx-auto max-w-[720px] px-6 py-16 lg:py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostingLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      {faqLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
        />
      )}
      {howToLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(howToLd) }}
        />
      )}

      <Link href="/notes/" className="lbl hover:text-[var(--accent)] transition-colors">
        ← All notes
      </Link>
      <p className="mt-8 lbl">{formatDate(meta.datePublished)}</p>
      <h1 className="mt-4 font-serif text-[clamp(36px,5vw,56px)] leading-[1.02] tracking-tight">
        {meta.title}
      </h1>
      <p className="mt-4 font-serif italic text-xl text-[var(--fg-muted)] leading-snug">
        {meta.description}
      </p>

      <div className="mt-16 max-w-none">
        <Content />
      </div>

      {meta.howTo && <HowToBlock howTo={meta.howTo} />}
      {meta.faq && meta.faq.length > 0 && <FAQBlock items={meta.faq} />}

      <div className="mt-20">
        <SubscribeForm variant="panel" />
      </div>
    </article>
  );
}
