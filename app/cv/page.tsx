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

      <p style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: 28, maxWidth: 620, lineHeight: 1.7 }}>
        {cvHeadline}
      </p>

      {/* Experience */}
      {cvExperience.map((job) => (
        <div key={`${job.period}-${job.company}`} className="card reveal">
          <div className="meta">{job.period} &middot; {job.company}</div>
          <h3>{job.role}</h3>
          {job.blurb && <p>{job.blurb}</p>}
          {job.bullets.length > 0 && (
            <ul style={{ fontSize: '12.5px', color: 'var(--muted)', lineHeight: 1.7, paddingLeft: 16, marginBottom: 10 }}>
              {job.bullets.map((b, i) => (
                <li key={i} style={{ marginBottom: 3 }}>{b}</li>
              ))}
            </ul>
          )}
          {job.stack && (
            <div className="tags">
              {job.stack.split('·').map((t) => (
                <span key={t.trim()} className="tag">{t.trim()}</span>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Side Projects */}
      <div style={{ marginTop: 28 }}>
        <h3>Side Projects</h3>
        <div className="project-grid" style={{ marginTop: 16 }}>
          {cvProjects.map((p) => (
            <div key={p.name} className="card reveal">
              <div className="meta">
                {p.link ? (
                  <a href={p.link.href} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                    {p.name} ↗
                  </a>
                ) : p.name}
              </div>
              <p>{p.body}</p>
              {p.meta && (
                <div className="tags">
                  {p.meta.split('·').map((t) => (
                    <span key={t.trim()} className="tag">{t.trim()}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Stack */}
      <div style={{ marginTop: 28 }}>
        <h3>Stack</h3>
        <div className="stack-grid" style={{ marginTop: 16 }}>
          {stackGroups.map((g) => (
            <div key={g.title} className="stack-group reveal">
              <h3 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {g.title}
              </h3>
              <div className="items">
                {g.items.map((i) => (
                  <span key={i} style={{ display: 'block' }}>{i}</span>
                ))}
              </div>
              <div className="note">{g.note}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Languages */}
      <div className="glance-box" style={{ display: 'inline-block', marginTop: 28 }}>
        <div className="mono">languages</div>
        <div className="content" style={{ fontSize: '12.5px' }}>
          {cvLanguages.map((l) => (
            <span key={l.name}>
              {l.name} ({l.level}){cvLanguages.indexOf(l) < cvLanguages.length - 1 ? ' · ' : ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
