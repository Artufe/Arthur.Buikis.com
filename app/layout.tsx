import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { fraunces, inter, jetBrainsMono } from './fonts';
import { ThemeProvider } from '@/components/theme-provider';
import { Nav } from '@/components/nav';
import { Footer } from '@/components/footer';
import { Gridlines } from '@/components/gridlines';
import { Grain } from '@/components/grain';
import { CommandPalette } from '@/components/command-palette';
import { site } from '@/content/site';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.name, template: `%s · ${site.name}` },
  description: site.description,
  openGraph: {
    title: site.name,
    description: site.description,
    url: site.url,
    siteName: site.name,
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${fraunces.variable} ${inter.variable} ${jetBrainsMono.variable}`}>
      <body className="min-h-screen">
        <ThemeProvider>
          <Gridlines />
          <Grain />
          <Nav />
          <main className="relative z-10 pt-20">{children}</main>
          <Footer />
          <CommandPalette />
        </ThemeProvider>
      </body>
    </html>
  );
}
