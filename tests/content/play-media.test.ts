import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { games } from '@/content/play';

const MB = 1024 * 1024;
const file = (publicPath: string) => path.join(process.cwd(), 'public', publicPath);

describe('/play media', () => {
  const all = games.flatMap((g) => [g.media, g.lightMedia].filter(Boolean).map((m) => ({ slug: g.slug, ...m! })));

  it.each(all)('$slug poster $poster exists and stays under 350 KB', ({ poster }) => {
    expect(existsSync(file(poster))).toBe(true);
    expect(statSync(file(poster)).size).toBeLessThan(350 * 1024);
  });

  it.each(all)('$slug clip $video exists and stays within budget', ({ slug, video }) => {
    expect(existsSync(file(video))).toBe(true);
    // GOLDENLINE's trailer earned a bigger budget (its spray); LITTLEBIG's descent stays small.
    expect(statSync(file(video)).size).toBeLessThan((slug === 'goldenline' ? 6 : 2) * MB);
  });

  const trailers = games.flatMap((g) => (g.trailer ? [{ slug: g.slug, ...g.trailer }] : []));

  it.each(trailers)('$slug trailer, its poster and chapter thumbnails exist within budget', ({ video, poster, chapters }) => {
    // Opened on demand (preload="none"), 1080p with sound.
    expect(statSync(file(video)).size).toBeLessThan(16 * MB);
    expect(statSync(file(poster)).size).toBeLessThan(350 * 1024);
    for (const c of chapters) expect(statSync(file(c.thumb)).size).toBeLessThan(60 * 1024);
  });
});
