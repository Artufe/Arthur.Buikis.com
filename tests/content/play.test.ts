import { describe, it, expect } from 'vitest';
import { games, method, PLAY_REPO } from '@/content/play';

describe('content/play', () => {
  it('points every game at an existing game route', () => {
    expect(games.map((g) => g.href)).toEqual(['/snake/', '/surf/', '/planet/']);
  });

  it('links each receipt Source row to that game’s PR', () => {
    for (const g of games) {
      const source = g.receipt.find((r) => r.label === 'Source');
      expect(source?.href).toBe(`${PLAY_REPO}/pull/${g.pr.number}`);
      expect(source?.value).toBe(`PR #${g.pr.number} ↗`);
    }
  });

  it('only links method sources into the public repo, grouped by game', () => {
    expect(method.sources.map((s) => s.game)).toEqual(games.map((g) => g.slug));
    const links = method.sources.flatMap((s) => s.links);
    expect(links.length).toBe(10);
    for (const s of links) expect(s.href.startsWith(`${PLAY_REPO}/`)).toBe(true);
    // Each game's group cites its own PR.
    for (const g of games) {
      const group = method.sources.find((s) => s.game === g.slug)!;
      expect(group.links.some((l) => l.href === `${PLAY_REPO}/pull/${g.pr.number}`)).toBe(true);
    }
  });

  it('draws the LITTLEBIG harness within its stated limit of four agents at once', () => {
    const { phases, tail } = method.harnessed.pipeline;
    expect(phases.length).toBe(4);
    for (const p of phases) expect(p.lanes.length).toBeLessThanOrEqual(4);
    expect(phases.flatMap((p) => p.lanes).length).toBe(11); // the eleven builder tasks
    expect(tail.at(-1)).toBe('PR #49');
  });
});
