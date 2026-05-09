import type { MetadataRoute } from 'next';
import { site } from '@/content/site';
import { getNotesIndex } from '@/lib/notes';

export const dynamic = 'force-static';

const STATIC_ROUTES = ['/', '/about/', '/building/', '/contact/', '/cv/', '/notes/', '/subscribe/'] as const;
const WORK_SLUGS = ['lethub-scraping-ml'] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const base = site.url.replace(/\/$/, '');

  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: path === '/' || path === '/notes/' ? 'weekly' : 'monthly',
    priority: path === '/' ? 1 : path === '/notes/' ? 0.9 : 0.7,
  }));

  const workEntries: MetadataRoute.Sitemap = WORK_SLUGS.map((slug) => ({
    url: `${base}/work/${slug}/`,
    lastModified: now,
    changeFrequency: 'yearly',
    priority: 0.8,
  }));

  const notes = await getNotesIndex();
  const noteEntries: MetadataRoute.Sitemap = notes.map(({ slug, meta }) => ({
    url: `${base}/notes/${slug}/`,
    lastModified: new Date(meta.datePublished),
    changeFrequency: 'monthly',
    priority: 0.7,
  }));

  return [...staticEntries, ...workEntries, ...noteEntries];
}
