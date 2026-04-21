import Link from 'next/link';
import { site } from '@/content/site';

export function Footer() {
  return (
    <footer className="border-t border-[var(--fg)]/10 mt-32">
      <div className="mx-auto max-w-[1600px] px-6 py-16 lg:px-16 lg:py-24">
        <div className="grid gap-12 md:grid-cols-3 md:gap-16">
          <div>
            <p className="font-serif text-2xl leading-tight">{site.name}</p>
            <p className="mt-3 text-sm text-[var(--fg-muted)]">{site.description}</p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Sitemap</p>
            <ul className="mt-4 space-y-2 text-sm">
              {site.nav.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Elsewhere</p>
            <ul className="mt-4 space-y-2 text-sm">
              <li><a href={`mailto:${site.email}`} className="hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]">{site.email}</a></li>
              {site.socials.map((s) => (
                <li key={s.href}>
                  <a href={s.href} target="_blank" rel="noreferrer" className="hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]">
                    {s.label} ↗
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-16 pt-8 border-t border-[var(--fg)]/5 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">
          © {new Date().getFullYear()} {site.name} — Built with care.
        </p>
      </div>
    </footer>
  );
}
