import type { Metadata } from 'next';
import { games } from '@/content/play';

// page.tsx is a client component, so the route's metadata lives here. Without it /planet/ would
// inherit the root canonical ('/') while being listed in the sitemap and llms routes.
const game = games.find((g) => g.slug === 'littlebig')!;
const title = game.title;
const description =
  'A tiny cartoon planet you orbit and spin, then dive through the clouds for a street-level walk. Procedural, zero asset downloads, three.js WebGL.';
const path = game.href;
const image = { url: game.media.poster, width: 1600, height: 1000, alt: game.media.alt };

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: path },
  openGraph: { type: 'website', title, description, url: path, images: [image] },
  twitter: { card: 'summary_large_image', title, description, images: [image.url] },
};

export default function PlanetLayout({ children }: { children: React.ReactNode }) {
  return children;
}
