import type { Metadata } from 'next';
import { ContactForm } from '@/components/contact-form';
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

const expectations = [
  <>I read everything. Replies usually land inside <em className="not-italic font-mono text-[12px] text-[var(--accent)]">2 working days</em>.</>,
  <>The shape of the system and what&apos;s getting in the way is more useful than a wish-list.</>,
  <>If a call works better, 30-minute slots are linked in most replies.</>,
];

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
            <div className="field">
              <input type="text" name="name" placeholder="name" required />
            </div>
            <div className="field">
              <input type="email" name="email" placeholder="email" required />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
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
            <div className="card direct-card">
              <div className="mono direct-card__label">direct</div>
              <a className="direct-card__email" href={`mailto:${site.email}`}>
                {site.email}
              </a>
              <p className="direct-card__meta">response within 24h</p>
              <div className="direct-card__divider" aria-hidden="true" />
              <div className="mono direct-card__label">also</div>
              <dl className="direct-card__also">
                <dt>Upwork</dt>
                <dd>100% Job Success</dd>
                <dt>LinkedIn</dt>
                <dd>arthur-buikis</dd>
                <dt>GitHub</dt>
                <dd>Artufe</dd>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
