import { site } from '@/content/site';

export const dynamic = 'force-static';

export function GET() {
  const base = site.url.replace(/\/$/, '');

  const lines = [
    `# ${site.name}`,
    '',
    `> ${site.bio.summary}`,
    '',
    'This site is a portfolio. The pages below cover background, current work, and case studies. Prose is the canonical source — JSON-LD on each page mirrors the same facts.',
    '',
    '## Pages',
    `- [Home](${base}/): summary, featured work, current focus`,
    `- [About](${base}/about/): background, working style`,
    `- [Building](${base}/building/): what I'm currently shipping`,
    `- [CV](${base}/cv/): full resume`,
    `- [Contact](${base}/contact/): how to get in touch`,
    '',
    '## Case studies',
    `- [Scraping, ML, and the cost of running quietly](${base}/work/lethub-scraping-ml/): two-year real-estate data platform — scraping at scale, deduplication, ML enrichment, reliability`,
    '',
    '## Skills',
    ...site.bio.knowsAbout.map((s) => `- ${s}`),
    '',
    '## Find me',
    ...site.socials.map((s) => `- ${s.label}: ${s.href}`),
    `- Email: ${site.email}`,
    '',
  ];

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
