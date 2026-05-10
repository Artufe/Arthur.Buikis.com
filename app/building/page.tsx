import type { Metadata } from 'next';
import Content, { meta } from '@/content/building/index.mdx';
import { site } from '@/content/site';

export const metadata: Metadata = {
  title: 'Building',
  description: 'What I\'m currently building — status, scope, and how to follow.',
};

export default function BuildingPage() {
  return (
    <div className="page" style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 28px 80px' }}>
      <div className="section-header">
        <h2>Building</h2>
        <div className="count">prototype · updated {meta.updated}</div>
      </div>

      <div className="l-asym">
        <div>
          <p style={{ fontSize: '13.5px', color: 'var(--muted)', marginBottom: 22, lineHeight: 1.7 }}>
            Quietly building a product platform. Details are intentionally thin while it&apos;s still in prototype, but the short version is this: a tool for operators who want what I want, in a space where most options still feel clumsy.
          </p>

          <div className="status-box reveal">
            <div className="mono">status</div>
            <p><strong>Prototype.</strong> It works for me. It&apos;s not ready for external hands yet. Growing it quietly, without the launch-day hype cycle.</p>
          </div>

          <h3>Why</h3>
          <p style={{ fontSize: '13.5px', color: 'var(--muted)', marginBottom: 22, lineHeight: 1.7 }}>
            Over the last decade, I&apos;ve watched the same problems get solved again and again inside different walled gardens. The goal here is to ship something small enough to move quickly, focused enough to be genuinely useful, and honest enough that people can always take their data with them.
          </p>

          <h3>What&apos;s next</h3>
          <ul className="beliefs">
            <li className="reveal">Make the core workflow bulletproof.</li>
            <li className="reveal">Bring in a small set of early users I trust to give direct, practical feedback.</li>
            <li className="reveal">Open it up publicly when the experience is boring in the best way.</li>
          </ul>

          <div style={{ marginTop: 32 }}>
            <Content />
          </div>
        </div>

        <div>
          <div className="side-sticky">
            <div className="card" style={{ padding: 16 }}>
              <div className="mono" style={{ marginBottom: 10 }}>follow</div>
              <p style={{ fontSize: '12.5px', color: 'var(--muted)', marginBottom: 14 }}>
                No newsletter. If you want to hear when it opens up, email me and I&apos;ll add you to a small list.
              </p>
              <a
                href={`mailto:${site.email}`}
                style={{
                  display: 'block',
                  padding: 9,
                  border: '2px solid var(--fg)',
                  textAlign: 'center',
                  textDecoration: 'none',
                  color: 'var(--fg)',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}
              >
                {site.email}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
