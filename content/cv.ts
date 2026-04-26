export interface CVExperience {
  role: string;
  company: string;
  period: string;
  location?: string;
  blurb?: string;
  bullets: string[];
  stack?: string;
}

export interface CVProject {
  name: string;
  link?: { label: string; href: string };
  body: string;
  meta?: string;
}

export interface CVLanguage {
  name: string;
  level: string;
}

export const cvHeadline =
  'Senior backend / platform engineer. About twelve years shipping data-heavy Python systems, with a bit of Rust where it earns its keep. Currently owning performance and ML-pipeline integration on a Django + Rust platform — translating research prototypes into services the production pipeline can safely run.';

export const cvExperience: CVExperience[] = [
  {
    role: 'Software Developer',
    company: 'Media-processing platform · Riga',
    period: '2024 → Present',
    blurb:
      'Own performance, reliability, and ML-pipeline integration of the CMS that drives 3D-scan uploads through panorama stitching, sky replacement, depth-map generation, room-layout estimation, and virtual-tour delivery. ~90 merged MRs across backend, infra, and a cross-repo Tauri desktop tool. Main touchpoint between R&D and production.',
    bullets: [
      'Brought Rust into a mature Python codebase. Shipped the first PyO3 / maturin extension for O(1) graph reads on large projects, then a critical-path ETA engine that walks the DAG of unfinished jobs using p50 duration percentiles, backed by an r2d2 Postgres pool that releases the GIL.',
      'Cut hot-path endpoint latency by 30–800×. work_started on 1,000 assets: 15.5 s → 19 ms (~815×). mark_artifacts_reviewed on 500 stills: 215 s → 6.9 s (~31×). mark_unreviewed for panos: 13.9 s → 0.08 s (~165×). Upload endpoint: 205 s → 128 s, with the rest pushed to async Celery.',
      'Indexed a 10M-row webhook table with zero downtime — partial B-tree on STATE_INITIAL, GIN jsonb_path_ops on payload, composite (state, created) — all shipped via non-atomic CREATE INDEX CONCURRENTLY migrations. Eliminated the sequential scans that were hammering deployment-resume and daily project-filter queries.',
      'Integrated 12+ ML processing clients into production: pano enhancement, sky replacement v2, monodepth, POI detection, pillar detection, house-number blur, image embeddings, TV replacement, and more. Each integration touches the processing-job schema, the graph engine, and the k8s deployment.',
      'Built the shadow-deployment / safe-rollout system. Quota-based experimental-features mechanism the team uses to ramp new ML models without risking the whole pipeline. Feature flags and dynamic settings govern 70+ namespaces and ~200 k8s artifact actions.',
      'Coplanner (workforce assignment). Real-time online tracking, role-based assignment permissions, and a dual-queue design (standard + student) backed by Redis Z-Sets with periodic rebuild and atomic pop.',
      'Platform-wide perf wins. stdlib json → orjson; toggleable global GZip via dynamic settings; rewrote a RAM-leaking metrics job from mocked zeros to efficient DB aggregation. Try to leave every endpoint in better shape for the next person.',
    ],
    stack:
      'Python · Django + Channels · DRF · Celery · RabbitMQ · PostgreSQL · MongoDB · Redis · Rust · PyO3 · maturin · Kubernetes · Kueue · Triton · Tauri v2 · React/TypeScript · orjson · Metabase · GitLab CI · Sentry',
  },
  {
    role: 'Freelance Full-Stack Developer',
    company: 'Upwork · Remote',
    period: '2017 → Present',
    blurb:
      '12+ backend and automation contracts with a 100% Job Success Score. Embedded in client teams or delivered solo — the long-standing relationships come from clear communication and not surprising people.',
    bullets: [],
  },
  {
    role: 'Senior Developer / Technical Support',
    company: 'Strange Logic · Brighton, UK (Remote)',
    period: '2018 – 2021 · 2021 – 2023',
    blurb:
      "Core engineering on TDN, Strange Logic's SaaS product. Streamlined L2/L3 support for the PHP application (500+ tickets resolved) and led the Stripe migration. On the second engagement, pushed for ClickHouse as a new back-end database and moved core APIs from PHP to Python. Kicked off the Expired Domain Search and Mass VAT Checker initiatives — both started as hallway conversations that grew into products.",
    bullets: [],
    stack: 'PHP · Python · ClickHouse · Celery · MySQL · Stripe · Linux',
  },
  {
    role: 'Web Scraping Automation Contractor',
    company: 'Lethub · Vancouver, BC (Remote)',
    period: '2021',
    blurb:
      'Built a Python pipeline that scraped listings from the three largest UK real-estate directories, and designed the schema that held up to 4.3 TB of listings, images, and historical sales records.',
    bullets: [],
    stack: 'Python · PostgreSQL · Selenium · Docker',
  },
];

export const cvProjects: CVProject[] = [
  {
    name: 'MarkFlow',
    link: { label: 'markflow.eu', href: 'https://markflow.eu' },
    body: 'Solo-built social-analytics SaaS wired into the Meta and Google ad APIs. Investment secured; quietly live with paying users.',
    meta: 'python · typescript · stripe',
  },
  {
    name: 'MyProxy',
    body: 'Designed a mobile-phone-as-4G/5G-proxy system with multi-device support, rotation, and a monitoring dashboard for paying B2B customers. Reduced cost per GB of mobile proxy data by up to 20×.',
    meta: 'python · android · infra',
  },
  {
    name: 'Expired Domain Search',
    body: 'Celery pipeline that crawled 700M+ domains over a year — DNS, WHOIS, screenshots, tech-stack fingerprinting, email extraction. Generated 43 TB of data across 12 servers.',
    meta: 'celery · clickhouse · dns / whois',
  },
];

export const cvLanguages: CVLanguage[] = [
  { name: 'Latvian', level: 'Native' },
  { name: 'English', level: 'Fluent' },
  { name: 'Russian', level: 'Conversational' },
  { name: 'German', level: 'Conversational' },
];
