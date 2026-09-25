import type { Metadata } from 'next';
import { site } from '@/content/site';

const title = 'Contact';
const description = 'Get in touch about freelance, consulting, or full-time work.';
const path = '/contact/';

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: path },
  openGraph: {
    type: 'website',
    title,
    description,
    url: path,
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
  },
};

export default function ContactPage() {
  return (
    <div className="page">
      <div className="section-header" style={{ padding: '0 28px', maxWidth: 1200, margin: '0 auto 20px' }}>
        <h2>Contact</h2>
        <div className="count">say hi</div>
      </div>
      <div className="l-asym" style={{ padding: '0 28px', maxWidth: 1200, margin: '0 auto' }}>
        <div>
          <form action={site.formspreeEndpoint} method="POST" className="contact-grid">
            {/* Honeypot: off-screen and skipped by keyboard/AT, so only bots fill it.
                Formspree silently discards any submission where `_gotcha` is non-empty. */}
            <input
              type="text"
              name="_gotcha"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              style={{ position: 'absolute', left: '-9999px', width: 0, height: 0 }}
            />
            <input type="text" name="name" placeholder="name" required />
            <input type="email" name="email" placeholder="email" required />
            <div style={{ gridColumn: '1 / -1' }}>
              <textarea name="message" placeholder="message" required />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <button type="submit">Send →</button>
            </div>
          </form>
          <div className="socials">
            {site.socials.map((s) => (
              <a key={s.href} href={s.href} target="_blank" rel="noopener">
                {s.label} ↗
              </a>
            ))}
          </div>
        </div>
        <div>
          <div className="side-sticky">
            <div className="card" style={{ padding: 16 }}>
              <div className="mono" style={{ marginBottom: 6 }}>direct</div>
              <p style={{ fontSize: 13, marginBottom: 3 }}>{site.email}</p>
              <p style={{ fontSize: '10.5px', color: 'var(--muted)' }}>response within 24h</p>
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '2px solid var(--border)' }}>
                <div className="mono" style={{ marginBottom: 6 }}>also</div>
                <div style={{ fontSize: 12, lineHeight: 2 }}>
                  Upwork: 100% Job Success<br />
                  LinkedIn: arthur-buikis<br />
                  GitHub: Artufe
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
