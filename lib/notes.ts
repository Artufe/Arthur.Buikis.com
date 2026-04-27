import fs from 'node:fs';
import path from 'node:path';

export interface NoteFAQ {
  q: string;
  a: string;
}

export interface NoteHowToStep {
  name: string;
  text: string;
}

export interface NoteHowTo {
  name: string;
  description?: string;
  steps: NoteHowToStep[];
}

export interface NoteMeta {
  title: string;
  description: string;
  date: string;
  datePublished: string;
  tags?: string[];
  image?: string;
  faq?: NoteFAQ[];
  howTo?: NoteHowTo;
}

export interface NoteModule {
  default: React.ComponentType;
  meta: NoteMeta;
}

const NOTES_DIR = path.join(process.cwd(), 'content', 'notes');

export function getNoteSlugs(): string[] {
  if (!fs.existsSync(NOTES_DIR)) return [];
  return fs
    .readdirSync(NOTES_DIR)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.replace(/\.mdx$/, ''));
}

export async function loadNote(slug: string): Promise<NoteModule> {
  return import(`@/content/notes/${slug}.mdx`);
}

export async function getNotesIndex(): Promise<Array<{ slug: string; meta: NoteMeta }>> {
  const slugs = getNoteSlugs();
  const entries = await Promise.all(
    slugs.map(async (slug) => ({ slug, meta: (await loadNote(slug)).meta })),
  );
  return entries.sort((a, b) => b.meta.datePublished.localeCompare(a.meta.datePublished));
}
