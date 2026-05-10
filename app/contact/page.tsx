import type { Metadata } from 'next';
import { ContactForm } from '@/components/contact-form';
import { site } from '@/content/site';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Get in touch about freelance, consulting, or full-time work.',
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
