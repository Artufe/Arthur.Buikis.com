'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { site } from '@/content/site';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';
import { openPalette } from '@/lib/palette-bus';

export function Nav() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const scrolledRef = useRef(false);

  useEffect(() => {
    let raf: number | null = null;
    const onScroll = () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        const next = window.scrollY > 8;
        if (next !== scrolledRef.current) {
          scrolledRef.current = next;
          setScrolled(next);
        }
        raf = null;
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => { setOpen(false); }, [pathname]);

  const isActive = (href: string) =>
    pathname === href || (href !== '/' && pathname !== null && pathname.startsWith(href));

  return (
    <nav
      className={cn(
        'header',
        scrolled || open ? 'scrolled' : ''
      )}
    >
      <div className="l-wrap">
        <Link
          href="/"
          className="brand"
          aria-label="Arthur Buikis — home"
        >
          <span className="signal" aria-hidden="true"><span /><span /><span /></span>
          a<span className="accent">b</span>.
        </Link>
        <nav className="nav-desktop" id="mainNav" aria-label="Primary">
          {site.nav.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn('nav-link', active ? 'active' : '')}
                aria-current={active ? 'page' : undefined}
              >
                {item.label.toLowerCase()}
              </Link>
            );
          })}
        </nav>
        <div className="nav-actions">
          <ThemeToggle />
          <button
            type="button"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="mobileNav"
            onClick={() => setOpen(!open)}
            className="hamburger-btn md:hidden"
          >
            {open ? <X size={18} strokeWidth={1.5} /> : <Menu size={18} strokeWidth={1.5} />}
          </button>
        </div>
      </div>
      {open && (
        <div id="mobileNav" className="mobile-nav open">
          {site.nav.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(active ? 'active' : '')}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}