import type { Metadata } from 'next';
import { cvHeadline, cvExperience, cvProjects, cvLanguages } from '@/content/cv';
import { stackGroups } from '@/content/about';
import { site } from '@/content/site';

const title = 'CV';
const description = 'Senior backend / platform engineer — Python, Rust, data pipelines, Kubernetes.';
const path = '/cv/';

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

// Map language level → number of filled segments (out of 4).
const LANG_LEVEL_FILLED: Record<string, number> = {
  native: 4,
  fluent: 4,
  professional: 3,
  working: 3,
  conversational: 2,
  basic: 1,
  beginner: 1,
};

function levelFilled(level: string): number {
  const key = level.trim().toLowerCase();
  return LANG_LEVEL_FILLED[key] ?? 2;
}

// Break a period string into stacked lines for the year column.
// "2024 → Present" → ["2024", "↓ Now"]
// "2018 – 2021 · 2021 – 2023" → ["2018 - 2021", "2021 - 2023"]
function periodLines(period: string): string[] {
  const norm = period.replace(/–|—/g, '-');
  if (norm.includes('·')) {
    return norm.split('·').map((s) => s.trim());
  }
  const arrow = norm.match(/^(\d{4})\s*→\s*(.+)$/);
  if (arrow) {
    const end = arrow[2].trim();
    const endLabel = /present/i.test(end) ? 'Now' : end;
    return [arrow[1], `↓ ${endLabel}`];
  }
  const dash = norm.match(/^(\d{4})\s*-\s*(\d{4})$/);
  if (dash) {
    return [dash[1], `↓ ${dash[2]}`];
  }
  return [norm];
}

export default function CVPage() {
  return (
    <div className="page" style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 28px 80px' }}>
      <div className="section-header">
        <h2>Curriculum Vit&aelig;</h2>
      </div>

      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 24, maxWidth: 620, lineHeight: 1.6 }}>
        {cvHeadline}
      </p>

      {/* === id-card: contact row === */}
      <dl className="cv-idcard" aria-label="Contact details">
        <div className="cv-idcard__row">
          <dt className="cv-idcard__lbl">Email</dt>
          <dd className="cv-idcard__val">
            <a href={`mailto:${site.email}`} className="ch">{site.email}</a>
          </dd>
        </div>
        <div className="cv-idcard__row">
          <dt className="cv-idcard__lbl">Based</dt>
          <dd className="cv-idcard__val">Riga, LV &middot; Remote &middot; EU-time</dd>
        </div>
        <div className="cv-idcard__row">
          <dt className="cv-idcard__lbl">Web</dt>
          <dd className="cv-idcard__val cv-idcard__socials">
            {site.socials.map((s, i) => (
              <span key={s.href}>
                <a href={s.href} target="_blank" rel="noreferrer" className="ch">{s.label}</a>
                {i < site.socials.length - 1 && <span className="cv-idcard__sep" aria-hidden="true"> / </span>}
              </span>
            ))}
          </dd>
        </div>
      </dl>

      {/* === download pdf button === */}
      <a href="/cv.pdf" download className="cv-pdf-btn">
        <span>Download PDF</span>
        <span aria-hidden="true" className="cv-pdf-btn__arrow">↓</span>
      </a>

      {/* === Experience as year-column timeline === */}
      <h3 style={{ marginBottom: 14, marginTop: 36 }}>Experience</h3>
      <ol className="cv-timeline">
        {cvExperience.map((job) => {
          const isCurrent = /present/i.test(job.period);
          const lines = periodLines(job.period);
          return (
            <li
              key={`${job.period}-${job.company}`}
              className={`cv-timeline__item${isCurrent ? ' is-current' : ''}`}
            >
              <div className="cv-timeline__years" aria-label={`Period: ${job.period}`}>
                {lines.map((ln, i) => (
                  <span key={i} className={i === 0 ? 'cv-timeline__year-main' : 'cv-timeline__year-sub'}>
                    {ln}
                  </span>
                ))}
              </div>
              <div className="cv-timeline__marker" aria-hidden="true" />
              <div className="cv-timeline__body">
                <div className="cv-timeline__head">
                  <span className="cv-timeline__role">{job.role}</span>
                  <span className="cv-timeline__company">{job.company}</span>
                </div>
                {job.blurb && <p className="cv-timeline__blurb">{job.blurb}</p>}
                {job.bullets.length > 0 && (
                  <ul className="cv-timeline__bullets">
                    {job.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}
                {job.stack && (
                  <div className="cv-timeline__stack" aria-label="Stack used">
                    {job.stack.split(' · ').map((t) => (
                      <span key={t.trim()} className="cv-pill">{t.trim()}</span>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* === Side Projects with tech tag rows === */}
      <h3 style={{ marginBottom: 14, marginTop: 36 }}>Side Projects</h3>
      <div className="cv-projects">
        {cvProjects.map((p) => {
          const tags = p.meta
            ? p.meta.split(' · ').map((t) => t.trim()).filter(Boolean)
            : [];
          return (
            <div key={p.name} className="cv-project">
              <div className="cv-project__head">
                {p.link ? (
                  <a href={p.link.href} target="_blank" rel="noreferrer" className="cv-project__name">
                    {p.name} <span aria-hidden="true">↗</span>
                  </a>
                ) : (
                  <span className="cv-project__name cv-project__name--plain">{p.name}</span>
                )}
              </div>
              <p className="cv-project__body">{p.body}</p>
              {tags.length > 0 && (
                <div className="cv-project__tags" aria-label="Tech stack">
                  {tags.map((t) => (
                    <span key={t} className="cv-pill">{t}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* === Stack (unchanged in this pass) === */}
      <h3 style={{ marginBottom: 14, marginTop: 36 }}>Stack</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
        {stackGroups.map((g) => (
          <div key={g.title} className="card" style={{ padding: '12px 16px', marginBottom: 0 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 4 }}>
              {g.title}
            </div>
            <div className="tags" style={{ gap: 3 }}>
              {g.items.map((i) => (
                <span key={i} className="tag">{i}</span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* === Languages with discrete level bars === */}
      <h3 style={{ marginBottom: 14, marginTop: 36 }}>Languages</h3>
      <div className="cv-langs">
        {cvLanguages.map((l) => {
          const filled = levelFilled(l.level);
          return (
            <div key={l.name} className="cv-lang">
              <span className="cv-lang__name">{l.name}</span>
              <span
                className="cv-lang__bar"
                role="img"
                aria-label={`${l.name}: ${l.level}`}
              >
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={`cv-lang__seg${i < filled ? ' is-on' : ''}`}
                    aria-hidden="true"
                  />
                ))}
              </span>
              <span className="cv-lang__level">{l.level}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
