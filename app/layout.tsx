import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/theme-provider';
import { Nav } from '@/components/nav';
import { Footer } from '@/components/footer';
import { ScanLine } from '@/components/scan-line';
import { HeroShader } from '@/components/hero-shader';
import { CommandPaletteLazy } from '@/components/command-palette-lazy';
import { SnakeWindowHost } from '@/components/snake/snake-window-host';
import { site } from '@/content/site';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.name, template: `%s · ${site.name}` },
  description: site.description,
  authors: [{ name: site.name, url: site.url }],
  creator: site.name,
  alternates: { canonical: '/' },
  openGraph: {
    title: site.name,
    description: site.description,
    url: site.url,
    siteName: site.name,
    type: 'website',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: site.name,
    description: site.description,
  },
};

const personLd = {
  '@context': 'https://schema.org',
  '@type': 'Person',
  '@id': `${site.url}/#person`,
  name: site.name,
  alternateName: 'Artūrs Buiķis',
  url: site.url,
  email: `mailto:${site.email}`,
  image: `${site.url}/opengraph-image.png`,
  jobTitle: site.bio.jobTitle,
  description: site.bio.summary,
  address: {
    '@type': 'PostalAddress',
    addressLocality: site.bio.location.city,
    addressCountry: site.bio.location.country,
  },
  knowsLanguage: ['Latvian', 'English', 'Russian', 'German'],
  knowsAbout: site.bio.knowsAbout,
  hasOccupation: {
    '@type': 'Occupation',
    name: site.bio.jobTitle,
    occupationLocation: {
      '@type': 'City',
      name: `${site.bio.location.city}, Latvia`,
    },
    skills:
      'Python, Rust, PyO3, Django, Celery, Kubernetes, PostgreSQL, ClickHouse, performance optimization, ML pipeline integration',
  },
  worksFor: [
    {
      '@type': 'Organization',
      name: 'MarkFlow',
      url: 'https://markflow.eu/',
      description: 'Solo-built social-analytics SaaS integrated with Meta and Google ad APIs.',
    },
  ],
  alumniOf: [
    {
      '@type': 'Organization',
      name: 'Strange Logic',
      url: 'https://strangelogic.com/',
    },
  ],
  sameAs: site.socials.map((s) => s.href),
};

const websiteLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': `${site.url}/#website`,
  url: site.url,
  name: site.name,
  description: site.description,
  inLanguage: 'en',
  publisher: { '@id': `${site.url}/#person` },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(personLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteLd) }}
        />
        <ThemeProvider>
          <HeroShader />
          <ScanLine />
          <Nav />
          <main className="relative z-10 pt-16">{children}</main>
          <Footer />
          <SnakeWindowHost />
          <CommandPaletteLazy />
        </ThemeProvider>
      </body>
    </html>
  );
}
