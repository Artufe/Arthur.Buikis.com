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
        'header',
        scrolled || open ? 'scrolled' : ''
      )}
    >
      <div className="l-wrap">
        <Link
          href="/"
          className="brand"
        >
          <span className="signal"><span /><span /><span /></span>
          a<span className="accent">b</span>.
        </Link>
        <nav className="nav-desktop" id="mainNav">
          {site.nav.map((item) => {
            const active = pathname === item.href || (item.href !== '/' && pathname !== null && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn('nav-link', active ? 'active' : '')}
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
            onClick={() => setOpen(!open)}
            className="hamburger-btn md:hidden"
          >
            {open ? <X size={18} strokeWidth={1.5} /> : <Menu size={18} strokeWidth={1.5} />}
          </button>
        </div>
      </div>
      {open && (
        <div className="mobile-nav open">
          {site.nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                pathname === item.href || (item.href !== '/' && pathname !== null && pathname.startsWith(item.href))
                  ? 'active' : ''
              )}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}
