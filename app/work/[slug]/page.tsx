import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { MetaRow } from '@/components/ui/meta-row';
import Link from 'next/link';

interface WorkModule {
  default: React.ComponentType;
  meta: {
    title: string;
    subtitle: string;
    date: string;
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
  return { title: meta.title, description: meta.subtitle };
}

export default async function WorkDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const load = works[slug];
  if (!load) notFound();
  const { default: Content, meta } = await load();

  return (
    <article className="mx-auto max-w-[720px] px-6 py-16 lg:py-24">
      <Link href="/#work" className="lbl hover:text-[var(--accent)] transition-colors">
        ← All work
      </Link>
      <p className="mt-8 lbl">Case study · {meta.date}</p>
      <h1 className="mt-4 font-serif text-[clamp(36px,5vw,56px)] leading-[1.02] tracking-tight">{meta.title}</h1>
      <p className="mt-4 font-serif italic text-xl text-[var(--fg-muted)] leading-snug">{meta.subtitle}</p>
      <MetaRow
        className="mt-10"
        items={[
          { label: 'Role', value: meta.role },
          { label: 'Stack', value: meta.stack },
          { label: 'Duration', value: meta.duration },
          { label: 'Outcome', value: meta.outcome },
        ]}
      />
      <div className="mt-16 max-w-none">
        <Content />
      </div>
    </article>
  );
}
