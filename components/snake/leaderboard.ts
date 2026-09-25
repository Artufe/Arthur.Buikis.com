export type LeaderboardEntry = { initials: string; score: number; length: number; date: number };

export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const LEADERBOARD_KEY = 'snake.leaderboard';
export const LEADERBOARD_SIZE = 10;
const VERSION = 1;

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

let fallback: KeyValueStore | null = null;

/** localStorage when usable, otherwise a per-session in-memory store. */
export function safeStorage(): KeyValueStore {
  try {
    const ls = window.localStorage;
    const probe = '__snake_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    fallback ??= memoryStore();
    return fallback;
  }
}

function isEntry(e: unknown): e is LeaderboardEntry {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.initials === 'string' &&
    /^[A-Z]{1,3}$/.test(r.initials) &&
    Number.isFinite(r.score) &&
    Number.isFinite(r.length) &&
    Number.isFinite(r.date)
  );
}

function sortEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort((a, b) => b.score - a.score || a.date - b.date);
}

export function loadLeaderboard(store: KeyValueStore): LeaderboardEntry[] {
  try {
    const raw = store.getItem(LEADERBOARD_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { v?: unknown; entries?: unknown };
    if (parsed?.v !== VERSION || !Array.isArray(parsed.entries)) return [];
    return sortEntries(parsed.entries.filter(isEntry)).slice(0, LEADERBOARD_SIZE);
  } catch {
    return [];
  }
}

export function saveLeaderboard(store: KeyValueStore, entries: LeaderboardEntry[]): void {
  try {
    store.setItem(LEADERBOARD_KEY, JSON.stringify({ v: VERSION, entries }));
  } catch {
    // Storage full or blocked: the table still lives in memory for this session.
  }
}

export function qualifies(entries: LeaderboardEntry[], score: number): boolean {
  if (score <= 0) return false;
  if (entries.length < LEADERBOARD_SIZE) return true;
  return score > entries[entries.length - 1].score;
}

export function insertEntry(
  entries: LeaderboardEntry[],
  entry: LeaderboardEntry,
): { entries: LeaderboardEntry[]; rank: number } {
  const all = sortEntries([...entries, entry]);
  const index = all.indexOf(entry);
  return { entries: all.slice(0, LEADERBOARD_SIZE), rank: index < LEADERBOARD_SIZE ? index : -1 };
}

export function normalizeInitials(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
}

export function readNumber(store: KeyValueStore, key: string): number {
  try {
    const n = parseInt(store.getItem(key) ?? '', 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function readString(store: KeyValueStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

export function writeString(store: KeyValueStore, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // ignore: best effort
  }
}
