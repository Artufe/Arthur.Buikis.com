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

export default function CVPage() {
  return (
    <div className="page" style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 28px 80px' }}>
      <div className="section-header">
        <h2>Curriculum Vit&aelig;</h2>
        <div className="count">
          <a
            href="/cv.pdf"
            download
            style={{ color: 'var(--accent)', textDecoration: 'underline', fontSize: 11 }}
          >
            download pdf ↓
          </a>
        </div>
      </div>

      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 20, maxWidth: 620, lineHeight: 1.6 }}>
        {cvHeadline}
      </p>

      <div
        className="mono"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 16px',
          paddingBottom: 16,
          marginBottom: 20,
          borderBottom: '2px solid var(--border)',
          fontSize: 11,
        }}
      >
        <span><span className="dim">Email: </span><a href={`mailto:${site.email}`} className="ch underline underline-offset-4">{site.email}</a></span>
        <span><span className="dim">Based: </span>Riga, LV · Remote · EU-time</span>
        {site.socials.map((s, i) => (
          <span key={s.href}>
            <a href={s.href} target="_blank" rel="noreferrer" className="ch underline underline-offset-4">{s.label}</a>
          </span>
        ))}
      </div>

      {/* Experience */}
      <h3 style={{ marginBottom: 10, marginTop: 0 }}>Experience</h3>
      {cvExperience.map((job) => (
        <div key={`${job.period}-${job.company}`} className="card" style={{ padding: '12px 16px', marginBottom: 8 }}>
          <div className="meta" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ fontSize: 11, fontWeight: 400, fontFamily: 'var(--font-display)', color: 'var(--fg)' }}>{job.role}</span>
            <span>{job.company}</span>
            <span style={{ marginLeft: 'auto' }}>{job.period}</span>
          </div>
          {job.blurb && (
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, marginBottom: 4, lineHeight: 1.5 }}>{job.blurb}</p>
          )}
          {job.bullets.length > 0 && (
            <ul style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, paddingLeft: 14, marginTop: 4, marginBottom: 4 }}>
              {job.bullets.map((b, i) => (
                <li key={i} style={{ marginBottom: 2 }}>{b}</li>
              ))}
            </ul>
          )}
          {job.stack && (
            <div className="tags" style={{ marginTop: 4, gap: 3 }}>
              {job.stack.split(' · ').map((t) => (
                <span key={t.trim()} className="tag">{t.trim()}</span>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Side Projects */}
      <h3 style={{ marginBottom: 10, marginTop: 22 }}>Side Projects</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
        {cvProjects.map((p) => (
          <div key={p.name} className="card" style={{ padding: '12px 16px', marginBottom: 0 }}>
            <div className="meta">
              {p.link ? (
                <a href={p.link.href} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 13 }}>
                  {p.name} ↗
                </a>
              ) : p.name}
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, marginBottom: 4, lineHeight: 1.5 }}>{p.body}</p>
            {p.meta && (
              <div className="tags" style={{ marginTop: 4, gap: 3 }}>
                {p.meta.split(' · ').map((t) => (
                  <span key={t.trim()} className="tag">{t.trim()}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Stack */}
      <h3 style={{ marginBottom: 10, marginTop: 22 }}>Stack</h3>
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

      {/* Languages */}
      <div className="card" style={{ padding: '12px 16px', marginTop: 22, marginBottom: 0, display: 'inline-block' }}>
        <div className="mono" style={{ fontSize: 10, marginBottom: 4 }}>languages</div>
        <div style={{ fontSize: 12, fontFamily: 'var(--font-body)' }}>
          {cvLanguages.map((l, i) => (
            <span key={l.name} className="dim">
              {l.name} <span style={{ color: 'var(--muted)', opacity: 0.6 }}>({l.level})</span>
              {i < cvLanguages.length - 1 && ' · '}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
