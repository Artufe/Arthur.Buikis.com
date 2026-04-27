import { ImageResponse } from 'next/og';
import { site } from '@/content/site';

export const dynamic = 'force-static';
export const alt = `${site.name} — ${site.description}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const BG = '#0F0F0F';
const FG = '#F5F3EF';
const FG_MUTED = 'rgba(245, 243, 239, 0.65)';
const ACCENT = '#FFB84D';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: BG,
          color: FG,
          padding: '80px 96px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 12, height: 12, background: ACCENT, borderRadius: 999 }} />
          <div style={{ fontSize: 22, letterSpacing: 4, color: FG_MUTED, textTransform: 'uppercase' }}>
            {site.url.replace(/^https?:\/\//, '')}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ fontSize: 110, lineHeight: 1.02, fontWeight: 500, letterSpacing: -2 }}>
            {site.name}
          </div>
          <div style={{ fontSize: 38, lineHeight: 1.3, color: FG_MUTED, maxWidth: 880 }}>
            {site.description}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 22, color: FG_MUTED, fontFamily: 'monospace' }}>
            {`${site.bio.location.city.toLowerCase()} · remote · eu-time`}
          </div>
          <div style={{ display: 'flex', gap: 28, fontSize: 22, color: FG_MUTED, fontFamily: 'monospace' }}>
            {site.bio.knowsAbout.slice(0, 4).map((tag) => (
              <span key={tag}>{tag.toLowerCase()}</span>
            ))}
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
