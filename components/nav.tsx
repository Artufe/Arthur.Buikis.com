'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { site } from '@/content/site';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

export function Nav() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav
      className={cn(
        'fixed top-0 left-0 right-0 z-50 transition-colors duration-[var(--dur-base)] border-b',
        scrolled
          ? 'bg-[var(--bg)]/80 backdrop-blur-md border-[var(--fg)]/10'
          : 'bg-transparent border-transparent'
      )}
    >
      <div className="mx-auto flex max-w-[1600px] items-center justify-between px-6 py-4 lg:px-16">
        <Link href="/" className="font-mono text-sm font-medium tracking-tight">
          {site.brand}
        </Link>
        <div className="flex items-center gap-6 md:gap-8">
          <ul className="hidden md:flex items-center gap-6 text-xs">
            {site.nav.map((item) => {
              const active = pathname === item.href || (item.href !== '/' && pathname !== null && pathname.startsWith(item.href));
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      'transition-colors duration-[var(--dur-fast)] hover:text-[var(--accent)]',
                      active ? 'text-[var(--fg)] font-medium' : 'text-[var(--fg-muted)]'
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
