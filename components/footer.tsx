import Link from 'next/link';
import { site } from '@/content/site';

export function Footer() {
  return (
    <footer className="border-t border-[var(--rule)] mt-32">
      <div className="mx-auto max-w-[1600px] px-6 py-16 lg:px-16 lg:py-24">
        <div className="grid gap-12 md:grid-cols-3 md:gap-16">
          <div>
            <p className="font-serif text-2xl leading-tight">{site.name}</p>
            <p className="mt-3 text-sm text-[var(--fg-muted)] max-w-[44ch]">{site.description}</p>
          </div>
          <div>
            <p className="lbl">Sitemap</p>
            <ul className="mt-4 space-y-2 font-mono text-[13px]">
              {site.nav.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="text-[var(--fg-muted)] hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]">
                    {item.label.toLowerCase()}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="lbl">Elsewhere</p>
            <ul className="mt-4 space-y-2 font-mono text-[13px]">
              <li>
                <a href={`mailto:${site.email}`} className="text-[var(--fg-muted)] hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]">
                  {site.email}
                </a>
              </li>
              {site.socials.map((s) => (
                <li key={s.href}>
                  <a href={s.href} target="_blank" rel="noreferrer" className="text-[var(--fg-muted)] hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]">
                    {s.label.toLowerCase()} <span className="text-[var(--fg-faint)]">↗</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-16 pt-8 border-t border-[var(--rule)] flex flex-wrap items-center justify-between gap-4">
          <p className="lbl">
            © {new Date().getFullYear()} {site.name}
          </p>
          <p className="font-mono text-[11px] text-[var(--fg-faint)]">
            built by hand · no trackers
          </p>
        </div>
      </div>
    </footer>
  );
}
