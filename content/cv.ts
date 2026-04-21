export interface CVExperience {
  role: string;
  company: string;
  period: string;
  location?: string;
  bullets: string[];
}

export const cvHeadline = 'Senior full-stack engineer specializing in Python backends, data pipelines, and performance-critical systems.';

export const cvExperience: CVExperience[] = [
  {
    role: 'Full-stack Freelance Developer',
    company: 'Upwork · Independent',
    period: '2024 – Present',
    bullets: [
      'Consulting on backend, data, and DevOps for product-stage startups.',
      'Concurrently building a personal product platform (details on /building).',
    ],
  },
  {
    role: 'Lead Software Developer',
    company: 'Strange Logic',
    period: '2023 – 2024',
    bullets: [
      'Led backend architecture and delivery for a team of four engineers.',
      'Scaled core services and introduced observability practices.',
    ],
  },
  {
    role: 'Software Developer',
    company: 'Lethub',
    period: '2022',
    bullets: [
      'Real-estate data platform — distributed scraping infrastructure, ML pipelines, and performance optimization.',
      'Responsible for throughput, reliability, and cost per record.',
    ],
  },
  {
    role: 'Software Developer',
    company: 'Strange Logic',
    period: '2019 – 2022',
    bullets: [
      'Full-stack feature delivery on Django + Docker product; later promoted to lead.',
    ],
  },
  {
    role: 'Junior Programmer',
    company: 'Bridge Media',
    period: '2018 – 2019',
    bullets: [
      'First full-time role. Shipped production features in Python and JavaScript.',
    ],
  },
  {
    role: 'Software Developer (Freelance)',
    company: 'Upwork',
    period: '2017 – 2018',
    bullets: [
      'Self-taught Python; delivered 7+ completed freelance projects.',
    ],
  },
];
