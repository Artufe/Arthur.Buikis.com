import type { MetadataRoute } from 'next';
import { site } from '@/content/site';

export const dynamic = 'force-static';

const STATIC_ROUTES = ['/', '/about/', '/building/', '/contact/', '/cv/'] as const;
const WORK_SLUGS = ['lethub-scraping-ml'] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const base = site.url.replace(/\/$/, '');

  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: path === '/' ? 'weekly' : 'monthly',
    priority: path === '/' ? 1 : 0.7,
  }));

  const workEntries: MetadataRoute.Sitemap = WORK_SLUGS.map((slug) => ({
    url: `${base}/work/${slug}/`,
    lastModified: now,
    changeFrequency: 'yearly',
    priority: 0.8,
  }));

  return [...staticEntries, ...workEntries];
}
