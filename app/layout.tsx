import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { fraunces, inter, jetBrainsMono } from './fonts';
import { ThemeProvider } from '@/components/theme-provider';
import { Nav } from '@/components/nav';
import { Footer } from '@/components/footer';
import { Gridlines } from '@/components/gridlines';
import { Grain } from '@/components/grain';
import { HeroShader } from '@/components/hero-shader';
import { CommandPaletteLazy } from '@/components/command-palette-lazy';
import { SnakeWindowHost } from '@/components/snake/snake-window-host';
import { site } from '@/content/site';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.name, template: `%s · ${site.name}` },
  description: site.description,
  alternates: { canonical: '/' },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
      { url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  manifest: '/site.webmanifest',
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

export const viewport: Viewport = {
  themeColor: '#0F0F0F',
};

const personLd = {
  '@context': 'https://schema.org',
  '@type': 'Person',
  '@id': `${site.url}/#person`,
  name: site.name,
  url: site.url,
  email: `mailto:${site.email}`,
  jobTitle: site.bio.jobTitle,
  description: site.bio.summary,
  address: {
    '@type': 'PostalAddress',
    addressLocality: site.bio.location.city,
    addressCountry: site.bio.location.country,
  },
  knowsAbout: site.bio.knowsAbout,
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
    <html lang="en" suppressHydrationWarning className={`${fraunces.variable} ${inter.variable} ${jetBrainsMono.variable}`}>
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
          <Gridlines />
          <Grain />
          <Nav />
          <main className="relative z-10 pt-20">{children}</main>
          <Footer />
          <SnakeWindowHost />
          <CommandPaletteLazy />
        </ThemeProvider>
      </body>
    </html>
  );
}
