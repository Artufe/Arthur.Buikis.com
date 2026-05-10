import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { site } from '@/content/site';

interface WorkModule {
  default: React.ComponentType;
  meta: {
    title: string;
    subtitle: string;
    date: string;
    datePublished: string;
    role: string;
    stack: string;
    duration: string;
    outcome: string;
  };
}

const works: Record<string, () => Promise<WorkModule>> = {
  'lethub-scraping-ml': () => import('@/content/work/lethub-scraping-ml.mdx'),
};

export function generateStaticParams() {
  return Object.keys(works).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const load = works[slug];
  if (!load) return { title: 'Not found' };
  const { meta } = await load();
  const path = `/work/${slug}/`;
  return {
    title: meta.title,
    description: meta.subtitle,
    alternates: { canonical: path },
    openGraph: {
      type: 'article',
      title: meta.title,
      description: meta.subtitle,
      url: path,
      publishedTime: meta.datePublished,
      authors: [site.name],
      images: ['/opengraph-image.png'],
    },
    twitter: {
      card: 'summary_large_image',
      title: meta.title,
      description: meta.subtitle,
    },
  };
}

export default async function WorkDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const load = works[slug];
  if (!load) notFound();
  const { default: Content, meta } = await load();

  const pageUrl = `${site.url}/work/${slug}/`;
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: meta.title,
    description: meta.subtitle,
    datePublished: meta.datePublished,
    image: {
      '@type': 'ImageObject',
      url: `${site.url}/opengraph-image.png`,
      width: 1200,
      height: 630,
    },
    author: { '@id': `${site.url}/#person` },
    mainEntityOfPage: pageUrl,
    isPartOf: { '@id': `${site.url}/#website` },
  };
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${site.url}/` },
      { '@type': 'ListItem', position: 2, name: 'Work', item: `${site.url}/#work` },
      { '@type': 'ListItem', position: 3, name: meta.title, item: pageUrl },
    ],
  };

  return (
    <article className="page" style={{ maxWidth: 720, margin: '0 auto', padding: '40px 28px 80px' }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      <div className="section-header">
        <Link href="/#work" className="count" style={{ textDecoration: 'underline' }}>
          ← All work
        </Link>
      </div>
      <div className="meta">{meta.date} · {meta.role}</div>
      <h1 className="mt-2">{meta.title}</h1>
      <p style={{ fontSize: '13.5px', color: 'var(--muted)', marginBottom: 10, lineHeight: 1.7 }}>
        {meta.subtitle}
      </p>

      <div className="card" style={{ padding: 14, marginBottom: 28 }}>
        <div className="tags">
          {['Role: ' + meta.role, 'Stack: ' + meta.stack, 'Duration: ' + meta.duration, 'Outcome: ' + meta.outcome].map((t) => (
            <span key={t} className="tag">{t}</span>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 'none' }}>
        <Content />
      </div>
    </article>
  );
}
