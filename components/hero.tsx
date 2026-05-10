import { TypewriterBar } from '@/components/typewriter-bar';
import { AnimatedStats } from '@/components/animated-stats';
import { site } from '@/content/site';
import { sideThings } from '@/content/about';

const stats = [
  { value: '12', label: 'years engineering' },
  { value: '12', label: 'contracts · 100% JSS' },
  { value: 'Py', label: 'Python native tongue' },
  { value: 'Riga', label: 'based · CET/CEST' },
];

export function Hero() {
  return (
    <section data-hero-region className="relative mx-auto max-w-[1600px] px-6 pt-20 pb-16 lg:px-16 lg:pt-28 lg:pb-24">
      <div className="grid gap-12 lg:grid-cols-[3fr_1fr] lg:gap-14">
        <div>
          <div className="font-mono text-[12px] text-[var(--muted)] tracking-wide" aria-hidden>
            <span className="text-[var(--accent)] mr-2">$</span>whoami --verbose
          </div>
          <h1 className="mt-5">
            Arthur<br />Buikis
          </h1>
          <p className="text-[clamp(15px,1.8vw,20px)] text-[var(--muted)] mb-2 leading-[1.4]">
            {site.bio.jobTitle} &middot; {site.bio.location.city}, {site.bio.location.country}
          </p>
          <TypewriterBar />
          <AnimatedStats items={stats} />
          <p className="text-[14px] text-[var(--muted)] max-w-[520px] leading-[1.7]">
            {site.bio.summary}
          </p>
        </div>
        <div>
          <div className="side-sticky">
            <div className="mono" style={{ marginBottom: 14 }}>featured</div>
            {sideThings.slice(0, 3).map((s) => (
              <div key={s.title} className="card" style={{ padding: 14, marginBottom: 6 }}>
                <div className="meta">{s.kind}</div>
                <h3 style={{ fontSize: 17, marginBottom: 3 }}>
                  {s.title}
                  {s.link ? ' ↗' : ''}
                </h3>
                <p style={{ fontSize: '11.5px', marginBottom: 0 }}>
                  {s.body.length > 70 ? s.body.slice(0, 70) + '…' : s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
