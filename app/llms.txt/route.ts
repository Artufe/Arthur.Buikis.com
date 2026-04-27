import { site } from '@/content/site';
import { getNotesIndex } from '@/lib/notes';

export const dynamic = 'force-static';

export async function GET() {
  const base = site.url.replace(/\/$/, '');
  const notes = await getNotesIndex();

  const noteLines = notes.length
    ? notes.slice(0, 20).map((n) => `- [${n.meta.title}](${base}/notes/${n.slug}/): ${n.meta.description}`)
    : ['- (none yet — first notes coming soon)'];

  const lines = [
    `# ${site.name}`,
    '',
    `> ${site.bio.summary}`,
    '',
    'This site is a portfolio plus an ongoing notes section on AI in production. Prose is the canonical source — JSON-LD on each page mirrors the same facts.',
    '',
    '## Pages',
    `- [Home](${base}/): summary, featured work, current focus`,
    `- [Notes](${base}/notes/): AI in production, not in pitches — short, opinionated takes from the senior-engineer side of AI/ML`,
    `- [About](${base}/about/): background, working style`,
    `- [Building](${base}/building/): what I'm currently shipping`,
    `- [CV](${base}/cv/): full resume`,
    `- [Contact](${base}/contact/): how to get in touch`,
    '',
    '## Recent notes',
    ...noteLines,
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
