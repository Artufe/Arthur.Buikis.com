import { describe, it, expect } from 'vitest';
import { games, method, PLAY_REPO } from '@/content/play';

describe('content/play', () => {
  it('points every game at an existing game route', () => {
    expect(games.map((g) => g.href)).toEqual(['/snake/', '/surf/']);
  });

  it('links each receipt Source row to that game’s PR', () => {
    for (const g of games) {
      const source = g.receipt.find((r) => r.label === 'Source');
      expect(source?.href).toBe(`${PLAY_REPO}/pull/${g.pr.number}`);
      expect(source?.value).toBe(`PR #${g.pr.number} ↗`);
    }
  });

  it('only links method sources into the public repo', () => {
    expect(method.sources.length).toBe(6);
    for (const s of method.sources) expect(s.href.startsWith(`${PLAY_REPO}/`)).toBe(true);
  });
});
