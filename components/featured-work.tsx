import Link from 'next/link';
import { ScrollReveal } from '@/components/scroll-reveal';

type Case = {
  tag: string;
  tagTone?: 'current' | 'past' | 'product';
  years: string;
  org: string;
  role: string;
  title: string;
  summary: string;
  meta: { label: string; value: string }[];
  cta: string;
  href?: string;
  external?: boolean;
};

const CASES: Case[] = [
  {
    tag: 'current',
    tagTone: 'current',
    years: '2024–now',
    org: 'media-processing platform',
    role: 'ic · backend',
    title: 'Python and Rust in a mature Django codebase.',
    summary:
      'Brought Rust (PyO3) into a production Python platform — started with a graph-read extension, grew into a critical-path ETA engine that walks the job DAG. Spent most of this year on hot-path latency; wins ran from about 30× to 800× depending on the endpoint. Also indexed a large webhook table with zero downtime, and built the shadow-deploy system that ramps new ML models safely.',
    meta: [
      { label: 'Role', value: 'IC · API-perf lead this quarter' },
      { label: 'Stack', value: 'python · rust · pyo3 · django · celery · k8s' },
      { label: 'Scope', value: '~90 MRs · ongoing' },
      { label: 'Outcome', value: 'perf wins · 12 ML clients plumbed in' },
    ],
    cta: 'Case notes · drafting →',
  },
  {
    tag: 'past',
    years: '2018–2023',
    org: 'strange-logic',
    role: 'senior developer',
    title: 'Crawling a lot of domains, looking for the interesting ones.',
    summary:
      'Celery pipeline that ran DNS, WHOIS, screenshots, and tech fingerprinting across expired domains — somewhere around 700M of them over about a year. 43 TB by the end. Separately, pushed the team through a PHP → Python migration and brought ClickHouse in when the analytics load stopped fitting in Postgres.',
    meta: [
      { label: 'Role', value: 'core engineer · later senior' },
      { label: 'Stack', value: 'python · celery · clickhouse · playwright · redis' },
      { label: 'Scope', value: 'multi-year' },
      { label: 'Outcome', value: '700M domains · 43 TB · php→python migration' },
    ],
    cta: 'Case notes →',
  },
  {
    tag: 'product',
    tagTone: 'product',
    years: '2023–',
    org: 'markflow · solo',
    role: 'founder · sole engineer',
    title: 'MarkFlow — a social-analytics SaaS I built solo.',
    summary:
      'Product work on the Meta and Google ad APIs — dashboard, ingest, billing. Quietly live at markflow.eu, with paying users. Also earlier: MyProxy (2020–2022), a mobile-phone-as-proxy service for B2B customers. We got the cost per GB down by roughly 20×.',
    meta: [
      { label: 'Role', value: 'solo founder · eng · product' },
      { label: 'Stack', value: 'python · typescript · react · meta/google apis · stripe' },
      { label: 'Scope', value: 'live product' },
      { label: 'Outcome', value: 'shipped · paying users' },
    ],
    cta: 'markflow.eu ↗',
    href: 'https://markflow.eu',
    external: true,
  },
];

function TagPill({ tag, tone }: { tag: string; tone?: Case['tagTone'] }) {
  const baseCls = 'px-2.5 py-0.5 border font-mono text-[10px] tracking-wide';
  if (tone === 'current') {
    return (
      <span className={`${baseCls} text-[var(--live)] border-[var(--live)]/40`}>
        <span className="mr-1.5">●</span>
        {tag}
      </span>
    );
  }
  return <span className={`${baseCls} text-[var(--fg-muted)] border-[var(--rule-strong)]`}>{tag}</span>;
}

function CaseItem({ c, first }: { c: Case; first: boolean }) {
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-[var(--fg-muted)]">
        <TagPill tag={c.tag} tone={c.tagTone} />
        <span>{c.years}</span>
        <span>{c.org}</span>
        <span>{c.role}</span>
      </div>
      <h3 className="mt-3 font-serif text-[26px] lg:text-[28px] leading-[1.1] tracking-tight max-w-[48ch]">
        {c.title}
      </h3>
      <p className="mt-3.5 text-[13px] leading-[1.7] text-[var(--fg-muted)] max-w-[72ch]">
        {c.summary}
      </p>
      <dl className="mt-4 pt-3.5 border-t border-[var(--rule)] flex flex-wrap gap-x-8 gap-y-3 font-mono text-[11px]">
        {c.meta.map((m) => (
          <div key={m.label}>
            <dt className="lbl mb-1">{m.label}</dt>
            <dd>{m.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 font-mono text-[11px] text-[var(--fg-muted)] underline underline-offset-4 decoration-[var(--rule-strong)] group-hover:text-[var(--accent)] group-hover:decoration-[var(--accent)] transition-colors duration-[var(--dur-fast)]">
        {c.cta}
      </p>
    </>
  );

  const borderCls = first ? 'border-t border-[var(--rule-strong)]' : 'border-t border-[var(--rule)]';
  const className = `group block py-7 ${borderCls}`;

  if (c.href && c.external) {
    return (
      <a href={c.href} target="_blank" rel="noreferrer" className={className}>
        {body}
      </a>
    );
  }
  if (c.href) {
    return (
      <Link href={c.href} className={className}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}

export function FeaturedWork() {
  return (
    <section
      id="work"
      className="mx-auto max-w-[1600px] px-6 py-20 lg:px-16 lg:py-28 border-t border-[var(--rule)]"
    >
      <ScrollReveal>
        <div className="grid gap-14 lg:grid-cols-[1fr_2.5fr]">
          <div>
            <p className="lbl">Selected work</p>
            <p className="mt-3 font-serif text-[30px] leading-[1.12] tracking-tight">
              Cases —<br />
              still writing<br />
              them.
            </p>
            <p className="mt-5 font-mono text-[10px] text-[var(--fg-faint)] leading-[1.6]">
              Three shown.
              <br />
              More as I write them up.
            </p>
          </div>
          <div className="flex flex-col">
            {CASES.map((c, i) => (
              <CaseItem key={c.title} c={c} first={i === 0} />
            ))}
            <Link
              href="/work/lethub-scraping-ml"
              className="mt-1 block py-5 font-mono text-[11px] text-[var(--fg-faint)] border-t border-dashed border-[var(--rule-strong)] hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]"
            >
              [ next case · lethub scraping pipeline — writing it up ]
            </Link>
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}
