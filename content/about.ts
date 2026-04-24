export type TimelineDot = 'live' | 'neutral';

export const timeline: {
  years: string;
  role: string;
  where: string;
  note: string;
  dot: TimelineDot;
}[] = [
  {
    years: '2024 → now',
    role: 'Software Developer',
    where: 'media-processing platform · riga',
    note: 'Python + Rust platform behind virtual tours. Performance, ML pipeline integration, Kubernetes plumbing.',
    dot: 'live',
  },
  {
    years: '2021 – 2023',
    role: 'Senior Developer',
    where: 'strange-logic · remote',
    note: 'Second stint on TDN. Led the PHP → Python migration, brought ClickHouse in, built the Expired Domain Search pipeline.',
    dot: 'neutral',
  },
  {
    years: '2021',
    role: 'Scraping Contractor',
    where: 'lethub · remote',
    note: 'Short contract. A scraping pipeline for UK real-estate directories — designed the schema that held the 4.3 TB of listings and history.',
    dot: 'neutral',
  },
  {
    years: '2018 – 2021',
    role: 'Developer',
    where: 'strange-logic · remote',
    note: 'First stint on TDN. Stripe migration, L2/L3 support work, and the start of what later became the second engagement.',
    dot: 'neutral',
  },
  {
    years: '2015 – 2018',
    role: 'Self-taught, then paid',
    where: 'upwork · early freelance',
    note: 'Python, scraping, automation. First paid projects while still figuring things out.',
    dot: 'neutral',
  },
];

export const throughline = {
  since: '2017 · upwork · freelance',
  delivered: '12+ contracts · 100% job-success',
  role: 'backend & automation',
};

export const atAGlance: { k: string; v: string }[] = [
  { k: 'based', v: 'Riga, LV' },
  { k: 'languages', v: 'LV · EN · RU · DE' },
  { k: 'time', v: 'EU (CET/CEST)' },
  { k: 'preference', v: 'remote · EU-time team' },
  { k: 'contracts', v: '12+ · 100% JSS' },
  { k: 'years writing python', v: 'since 2015' },
];

export const stackGroups: {
  title: string;
  items: string[];
  note: string;
}[] = [
  {
    title: 'Primary',
    items: ['python', 'rust', 'typescript', 'sql · bash'],
    note: "Python's the native tongue. Rust where it earns its keep.",
  },
  {
    title: 'Platform & Infra',
    items: [
      'django · drf · channels',
      'fastapi · flask',
      'celery · rabbitmq · redis',
      'kubernetes · docker',
      'gitlab-ci · jenkins',
    ],
    note: 'Boring tech. Intentionally.',
  },
  {
    title: 'Data & ML',
    items: [
      'postgresql · clickhouse',
      'mongodb · mysql',
      'triton inference',
      'shadow deploys · rollouts',
      'playwright · selenium',
    ],
    note: "Mostly plumbing. The models aren't the hard part.",
  },
  {
    title: 'Everyday',
    items: [
      'sentry · prometheus · grafana',
      'pyo3 · maturin · serde',
      'orjson · pytest · asyncio',
      'stripe · oauth',
      'tauri · react',
    ],
    note: 'Things on the keyboard this month.',
  },
];

export const sideThings: {
  kind: string;
  title: string;
  body: string;
  meta: string;
  link?: { label: string; href: string };
}[] = [
  {
    kind: 'product · 2023– · live',
    title: 'MarkFlow',
    body: 'Solo-built social-analytics SaaS wired into the Meta and Google ad APIs. Quietly live at markflow.eu, with paying users.',
    meta: 'python · typescript · stripe',
    link: { label: 'markflow.eu ↗', href: 'https://markflow.eu' },
  },
  {
    kind: 'product · 2020–2022 · sunset',
    title: 'MyProxy',
    body: 'Mobile-phone-as-proxy service for B2B customers. Multi-device rotation, a monitoring dashboard, paying accounts. Cost per GB came down by roughly 20× over the run.',
    meta: 'python · android · infra',
  },
  {
    kind: 'work · 2018–2023 · strange-logic',
    title: 'Expired Domain Search',
    body: 'Celery pipeline that crawled around 700M expired domains — DNS, WHOIS, screenshots, tech fingerprinting, email extraction. 43 TB across 12 servers by the end.',
    meta: 'celery · clickhouse · dns/whois',
  },
];

export const antiList = [
  "Rewrite something that's working just because it looks old.",
  'Reach for a new framework before the existing one is actually maxed out.',
  'Ship a big change without a rollout plan and a way to back it out.',
  'Treat "we don\'t have tests for that" as the same sentence as "we don\'t have observability for that." One is harder to live without.',
  "Promise an estimate for a system I haven't read yet.",
];

export const beliefs = [
  "Code that doesn't need to be rewritten next year is more valuable than code that's clever today.",
  'Observability beats tests. Knowing something broke in prod is worth more than knowing it passed locally.',
  'Most "performance problems" are architecture problems one layer up.',
  "The best engineers I've worked with are boring to watch. They delete more than they add.",
];
