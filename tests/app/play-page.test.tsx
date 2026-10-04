import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import PlayPage from '@/app/play/page';
import { games, method, PLAY_REPO } from '@/content/play';
import { installMediaMocks } from '../helpers/media-mocks';

beforeEach(() => {
  installMediaMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PlayPage', () => {
  it('links every card straight to its game route', () => {
    render(<PlayPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Two games, built with agents.' })).toBeDefined();
    // next/link drops the trailing slash without next.config's trailingSlash; the export keeps it.
    const route = (href: string | null) => href?.replace(/\/$/, '');
    for (const g of games) {
      expect(route(screen.getByRole('link', { name: `Play ${g.title}` }).getAttribute('href'))).toBe(route(g.href));
    }
  });

  it('shows every receipt row under its card', () => {
    render(<PlayPage />);
    for (const g of games) {
      const card = within(screen.getByRole('link', { name: `Play ${g.title}` }).closest('article')!);
      for (const row of g.receipt) {
        expect(card.getByText(row.label)).toBeDefined();
        expect(card.getByText(row.value)).toBeDefined();
      }
    }
  });

  it('opens every repo link in a new tab', () => {
    render(<PlayPage />);
    const repoLinks = screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith(PLAY_REPO));
    expect(repoLinks.length).toBe(games.length + method.sources.length);
    for (const a of repoLinks) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noreferrer');
    }
  });
});
