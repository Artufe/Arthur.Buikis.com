import { site } from '@/content/site';

// The site-wide share card: app/opengraph-image.tsx renders it, and scripts/postbuild.mjs renames it
// to .png. A page that sets its own `openGraph` replaces the root one, image included, so it has to
// list this image again or its link previews go without a picture.
export const ogImage = {
  url: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: `${site.name} — ${site.description}`,
};
