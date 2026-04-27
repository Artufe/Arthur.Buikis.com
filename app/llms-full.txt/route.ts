import fs from 'node:fs/promises';
import path from 'node:path';
import { site } from '@/content/site';

export const dynamic = 'force-static';

const WORK_SLUGS = ['lethub-scraping-ml'] as const;

async function readWorkProse(slug: string) {
  const file = path.join(process.cwd(), 'content', 'work', `${slug}.mdx`);
  const raw = await fs.readFile(file, 'utf-8');
  const cut = raw.indexOf('};');
  return cut >= 0 ? raw.slice(cut + 2).trim() : raw.trim();
}

export async function GET() {
  const base = site.url.replace(/\/$/, '');

  const header = [
    `# ${site.name}`,
    '',
    site.bio.summary,
    '',
    `URL: ${base}`,
    `Location: ${site.bio.location.city}, ${site.bio.location.country} (${site.bio.location.timezone})`,
    `Email: ${site.email}`,
    '',
    '## Skills',
    site.bio.knowsAbout.join(', '),
    '',
    '## Find me',
    ...site.socials.map((s) => `- ${s.label}: ${s.href}`),
    '',
    '## Pages',
    `- ${base}/ — summary, featured work`,
    `- ${base}/about/ — background, working style`,
    `- ${base}/building/ — current work in flight`,
    `- ${base}/cv/ — full resume`,
    `- ${base}/contact/ — how to get in touch`,
    '',
    '---',
    '',
    '# Case studies',
    '',
  ].join('\n');

  const cases = await Promise.all(
    WORK_SLUGS.map(async (slug) => {
      const prose = await readWorkProse(slug);
      return `## ${base}/work/${slug}/\n\n${prose}\n`;
    }),
  );

  return new Response(header + cases.join('\n---\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
