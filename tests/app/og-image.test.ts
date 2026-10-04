import { describe, it, expect } from 'vitest';
import type { Metadata } from 'next';
import { ogImage } from '@/lib/og';
import { metadata as about } from '@/app/about/page';
import { metadata as contact } from '@/app/contact/page';
import { metadata as cv } from '@/app/cv/page';
import { metadata as play } from '@/app/play/page';

// A page's own `openGraph` replaces the root one, image included (building and work/[slug] import
// MDX, so the build output covers them).
describe('share image', () => {
  it.each([
    ['about', about],
    ['contact', contact],
    ['cv', cv],
    ['play', play],
  ] as [string, Metadata][])('/%s lists the site card in its openGraph', (_, m) => {
    expect(m.openGraph?.images).toEqual([ogImage]);
  });
});
