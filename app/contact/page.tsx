import type { Metadata } from 'next';
import { ContactForm } from '@/components/contact-form';
import { site } from '@/content/site';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Get in touch about freelance, consulting, or full-time work.',
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-16 lg:px-16 lg:py-24">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--fg-muted)]">Contact</p>
      <h1 className="mt-4 font-serif text-[clamp(40px,5vw,64px)] leading-[1.02] tracking-tight">Get in touch.</h1>

      <div className="mt-20 grid gap-16 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Direct</p>
          <a href={`mailto:${site.email}`} className="mt-4 block font-serif text-2xl underline underline-offset-4 decoration-[var(--fg)]/30 hover:decoration-[var(--accent)] hover:text-[var(--accent)] transition-colors">
            {site.email}
          </a>
          <p className="mt-12 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Elsewhere</p>
          <ul className="mt-4 space-y-2 text-sm">
            {site.socials.map((s) => (
              <li key={s.href}>
                <a href={s.href} target="_blank" rel="noreferrer" className="hover:text-[var(--accent)] transition-colors">{s.label} ↗</a>
              </li>
            ))}
          </ul>
        </div>
        <div className="lg:col-span-7 lg:col-start-6">
          <ContactForm />
        </div>
      </div>
    </div>
  );
}
