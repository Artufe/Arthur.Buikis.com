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
    <div className="mx-auto max-w-[1600px] px-6 pt-12 pb-20 lg:px-16 lg:pt-16 lg:pb-28">
      <div className="font-mono text-[11px] text-[var(--fg-muted)]">
        <span className="text-[var(--accent)] mr-2">$</span>echo &quot;hi&quot; | mail
      </div>
      <h1 className="mt-5 font-serif text-[clamp(48px,7vw,80px)] leading-[0.96] tracking-[-0.03em] font-medium">
        Get in touch.
      </h1>

      <div className="mt-14 grid gap-16 lg:grid-cols-[1fr_1.3fr]">
        <div>
          <div className="mb-8">
            <p className="lbl">Direct</p>
            <a
              href={`mailto:${site.email}`}
              className="mt-2.5 inline-block font-serif text-[22px] underline underline-offset-[6px] decoration-[var(--rule-strong)] hover:decoration-[var(--accent)] hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]"
            >
              {site.email}
            </a>
          </div>

          <div className="mb-8">
            <p className="lbl">Elsewhere</p>
            <ul className="mt-3 font-mono text-[13px] leading-[2] text-[var(--fg)]/85">
              {site.socials.map((s) => (
                <li key={s.href}>
                  <a
                    href={s.href}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]"
                  >
                    {s.label} <span className="text-[var(--fg-faint)]">↗</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="lbl">What to expect</p>
            <div className="mt-3 max-w-[40ch] space-y-3">
              {expectations.map((line, i) => (
                <p key={i} className="text-[13px] leading-[1.7] text-[var(--fg)]/78">
                  {line}
                </p>
              ))}
            </div>
          </div>
        </div>

        <div>
          <ContactForm />
        </div>
      </div>
    </div>
  );
}
