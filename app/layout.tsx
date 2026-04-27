import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { fraunces, inter, jetBrainsMono } from './fonts';
import { ThemeProvider } from '@/components/theme-provider';
import { Nav } from '@/components/nav';
import { Footer } from '@/components/footer';
import { Gridlines } from '@/components/gridlines';
import { Grain } from '@/components/grain';
import { HeroShader } from '@/components/hero-shader';
import { CommandPaletteLazy } from '@/components/command-palette-lazy';
import { site } from '@/content/site';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.name, template: `%s · ${site.name}` },
  description: site.description,
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
  name: site.name,
  url: site.url,
  email: `mailto:${site.email}`,
  jobTitle: 'Senior software engineer',
  description: site.description,
  sameAs: site.socials.map((s) => s.href),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${fraunces.variable} ${inter.variable} ${jetBrainsMono.variable}`}>
      <body className="min-h-screen">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(personLd) }}
        />
        <ThemeProvider>
          <HeroShader />
          <Gridlines />
          <Grain />
          <Nav />
          <main className="relative z-10 pt-20">{children}</main>
          <Footer />
          <CommandPaletteLazy />
        </ThemeProvider>
      </body>
    </html>
  );
}
