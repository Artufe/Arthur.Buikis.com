import type { Metadata } from 'next';
import {
  timeline,
  throughline,
  atAGlance,
  stackGroups,
  antiList,
  beliefs,
} from '@/content/about';
import { site } from '@/content/site';

export const metadata: Metadata = {
  title: 'About',
  description: 'Backend & platform engineer · Riga · twelve-ish years in.',
};

export default function AboutPage() {
  return (
    <div className="page" style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 28px 80px' }}>
      <div className="section-header">
        <h2>About</h2>
        <div className="count">since 2015</div>
      </div>

      <div className="l-asym">
        <div>
          {/* Timeline */}
          <div className="tl">
            {timeline.map((t) => (
              <div key={t.years} className={`tl-item${t.dot === 'live' ? ' live' : ''} reveal`}>
                <div className="years">{t.years}</div>
                <div className="role">{t.role}</div>
                <div className="where">{t.where}</div>
                <div className="note">{t.note}</div>
              </div>
            ))}
          </div>

          {/* Throughline */}
          <div className="card" style={{ padding: '14px 18px', marginTop: 32 }}>
            <div className="meta">constant since</div>
            <p style={{ fontSize: 13, margin: 0 }}>
              {throughline.since} · {throughline.delivered} · {throughline.role}
            </p>
          </div>

          {/* Beliefs */}
          <div style={{ marginTop: 44 }}>
            <h3>Beliefs</h3>
            <ul className="beliefs">
              {beliefs.map((b, i) => (
                <li key={i} className="reveal">{b}</li>
              ))}
            </ul>
          </div>

          {/* Anti-list */}
          <div style={{ marginTop: 28 }}>
            <h3>Avoid</h3>
            <ul className="anti-list">
              {antiList.map((a, i) => (
                <li key={i} className="reveal">{a}</li>
              ))}
            </ul>
          </div>
        </div>

        <div>
          <div className="side-sticky">
            {/* Stack */}
            <h3 style={{ fontSize: 17, marginBottom: 16 }}>Stack</h3>
            <div className="stack-grid" style={{ gridTemplateColumns: '1fr' }}>
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

            {/* At a glance */}
            <div className="glance-box reveal">
              <div className="mono">at a glance</div>
              <div className="content">
                {atAGlance.map((row) => (
                  <div key={row.k}>
                    <span style={{ color: 'var(--muted)' }}>{row.k}: </span>
                    {row.v}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
