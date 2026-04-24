'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { site } from '@/content/site';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';
import { openPalette } from '@/lib/palette-bus';

export function Nav() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <nav
      className={cn(
        'fixed top-0 left-0 right-0 z-50 transition-colors duration-[var(--dur-base)] border-b',
        scrolled || open
          ? 'bg-[var(--bg)]/90 backdrop-blur-md border-[var(--rule)]'
          : 'bg-transparent border-transparent'
      )}
    >
      <div className="mx-auto flex max-w-[1600px] items-center justify-between px-6 py-4 lg:px-16">
        <Link
          href="/"
          className="font-mono text-sm tracking-tight inline-flex items-center gap-2"
        >
          <span className="text-[var(--accent)]">§</span>
          <span>{site.brand}</span>
        </Link>
        <div className="flex items-center gap-4 md:gap-6">
          <ul className="hidden md:flex items-center gap-6 font-mono text-[11px] tracking-wide">
            {site.nav.map((item) => {
              const active = pathname === item.href || (item.href !== '/' && pathname !== null && pathname.startsWith(item.href));
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      'transition-colors duration-[var(--dur-fast)] hover:text-[var(--accent)]',
                      active ? 'text-[var(--fg)]' : 'text-[var(--fg-muted)]'
                    )}
                  >
                    {item.label.toLowerCase()}
                  </Link>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => openPalette()}
            aria-label="Open command palette"
            className="hidden md:inline-flex items-center gap-2 font-mono text-[11px] text-[var(--fg-muted)] hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]"
          >
            <span className="kbd">/</span>
            <span>commands</span>
          </button>
          <ThemeToggle />
          <button
            type="button"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen(!open)}
            className="md:hidden inline-flex h-10 w-10 items-center justify-center"
          >
            {open ? <X size={18} strokeWidth={1.5} /> : <Menu size={18} strokeWidth={1.5} />}
          </button>
        </div>
      </div>
      {open && (
        <div className="md:hidden border-t border-[var(--rule)] bg-[var(--bg)]">
          <ul className="flex flex-col px-6 py-6 gap-4">
            {site.nav.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="font-serif text-2xl hover:text-[var(--accent)] transition-colors">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
