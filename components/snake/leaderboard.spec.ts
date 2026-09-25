import { describe, expect, it } from 'vitest';
import {
  insertEntry,
  LEADERBOARD_KEY,
  loadLeaderboard,
  normalizeInitials,
  qualifies,
  readNumber,
  safeStorage,
  saveLeaderboard,
  type KeyValueStore,
  type LeaderboardEntry,
} from './leaderboard';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const entry = (score: number, date: number, initials = 'AAA'): LeaderboardEntry => ({ initials, score, length: 10, date });

describe('leaderboard', () => {
  it('keeps the top 10 sorted by score, earlier date first on ties', () => {
    let entries: LeaderboardEntry[] = [];
    for (let i = 0; i < 12; i++) entries = insertEntry(entries, entry(i, i)).entries;
    expect(entries).toHaveLength(10);
    expect(entries[0].score).toBe(11);
    expect(entries.at(-1)!.score).toBe(2);
    const tie = insertEntry(entries, entry(11, 100, 'NEW'));
    expect(tie.rank).toBe(1);
    expect(tie.entries[0].date).toBe(11);
  });

  it('reports the rank, or -1 when the entry fell off', () => {
    const full = Array.from({ length: 10 }, (_, i) => entry(100 - i, i));
    expect(insertEntry(full, entry(95.5, 50)).rank).toBe(5);
    expect(insertEntry(full, entry(1, 50)).rank).toBe(-1);
  });

  it('qualifies only positive scores that beat the last place of a full table', () => {
    const full = Array.from({ length: 10 }, (_, i) => entry(100 - i, i));
    expect(qualifies([], 0)).toBe(false);
    expect(qualifies([], 1)).toBe(true);
    expect(qualifies(full, 91)).toBe(false);
    expect(qualifies(full, 92)).toBe(true);
  });

  it('round-trips through storage', () => {
    const store = memory();
    saveLeaderboard(store, [entry(5, 1, 'ABC')]);
    expect(loadLeaderboard(store)).toEqual([entry(5, 1, 'ABC')]);
  });

  it('recovers from corrupt or foreign data', () => {
    const store = memory();
    store.setItem(LEADERBOARD_KEY, '{not json');
    expect(loadLeaderboard(store)).toEqual([]);
    store.setItem(LEADERBOARD_KEY, JSON.stringify({ v: 99, entries: [entry(1, 1)] }));
    expect(loadLeaderboard(store)).toEqual([]);
    store.setItem(LEADERBOARD_KEY, JSON.stringify({ v: 1, entries: [entry(1, 1), { junk: true }] }));
    expect(loadLeaderboard(store)).toEqual([entry(1, 1)]);
  });

  it('survives a store that throws', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(loadLeaderboard(broken)).toEqual([]);
    expect(() => saveLeaderboard(broken, [entry(1, 1)])).not.toThrow();
    expect(readNumber(broken, 'snake.best')).toBe(0);
  });

  it('safeStorage falls back to memory when localStorage throws', () => {
    // jsdom may define localStorage on the instance or on the prototype; handle both.
    const desc = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      const store = safeStorage();
      store.setItem('k', 'v');
      expect(store.getItem('k')).toBe('v');
    } finally {
      if (desc) Object.defineProperty(window, 'localStorage', desc);
      else delete (window as unknown as Record<string, unknown>).localStorage;
    }
  });

  it('normalises initials to at most three capital letters', () => {
    expect(normalizeInitials('ab1c-d')).toBe('ABC');
    expect(normalizeInitials('')).toBe('');
  });
});
