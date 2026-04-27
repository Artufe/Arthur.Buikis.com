import fs from 'node:fs/promises';
import path from 'node:path';
import { site } from '@/content/site';
import { getNotesIndex } from '@/lib/notes';

export const dynamic = 'force-static';

const WORK_SLUGS = ['lethub-scraping-ml'] as const;

async function readMdxProse(file: string) {
  const raw = await fs.readFile(file, 'utf-8');
  const cut = raw.indexOf('};');
  return cut >= 0 ? raw.slice(cut + 2).trim() : raw.trim();
}

async function readWorkProse(slug: string) {
  return readMdxProse(path.join(process.cwd(), 'content', 'work', `${slug}.mdx`));
}

async function readNoteProse(slug: string) {
  return readMdxProse(path.join(process.cwd(), 'content', 'notes', `${slug}.mdx`));
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

  const notes = await getNotesIndex();
  const noteSections = await Promise.all(
    notes.map(async ({ slug, meta }) => {
      const prose = await readNoteProse(slug);
      return `## ${meta.title}\n${base}/notes/${slug}/ — ${meta.datePublished}\n\n${meta.description}\n\n${prose}\n`;
    }),
  );

  const notesHeader = notes.length
    ? '\n---\n\n# Notes\n\n' + noteSections.join('\n---\n\n')
    : '';

  return new Response(header + cases.join('\n---\n\n') + notesHeader, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
