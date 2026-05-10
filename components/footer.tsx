import Link from 'next/link';
import { site } from '@/content/site';

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-main">
          <div className="footer-col">
            <p className="brand" style={{ fontSize: 22, fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}>
              a<span className="accent">b</span>.
            </p>
            <p className="text-[var(--muted)]" style={{ fontSize: 12, marginTop: 6, maxWidth: '36ch', lineHeight: 1.6 }}>
              {site.description}
            </p>
          </div>
          <div className="footer-col">
            <p className="mono" style={{ marginBottom: 10 }}>Sitemap</p>
            <ul className="footer-links">
              {site.nav.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="footer-link">
                    {item.label.toLowerCase()}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div className="footer-col">
            <p className="mono" style={{ marginBottom: 10 }}>Elsewhere</p>
            <ul className="footer-links">
              <li>
                <a href={`mailto:${site.email}`} className="footer-link">
                  {site.email}
                </a>
              </li>
              {site.socials.map((s) => (
                <li key={s.href}>
                  <a href={s.href} target="_blank" rel="noreferrer" className="footer-link">
                    {s.label.toLowerCase()} ↗
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <p className="mono">
            © {new Date().getFullYear()} {site.name}
          </p>
          <p className="mono">built by hand · no trackers</p>
        </div>
      </div>
    </footer>
  );
}
