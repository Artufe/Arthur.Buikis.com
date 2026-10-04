// The header's GitHub pulse: contribution counts per month for the last 12 months. The data is
// fetched at build time by scripts/github-pulse.mjs into content/github-pulse.json. This file has
// no imports, so that script can load it through Node's type stripping.

export type PulseMonth = { month: string; count: number }; // month: 'YYYY-MM'

export type Pulse = {
  login: string;
  fetchedAt: string; // YYYY-MM-DD
  total: number; // GitHub's own "contributions in the last year", as the profile shows it
  commits: number;
  pullRequests: number;
  months: PulseMonth[]; // 12 entries, oldest first; the last is the current month so far
};

// Buckets the contribution calendar into the 12 calendar months ending with today's month.
export function toMonths(days: { date: string; contributionCount: number }[], today: string): PulseMonth[] {
  const [y, m] = today.split('-').map(Number);
  const months: PulseMonth[] = [];
  for (let i = 11; i >= 0; i--) {
    months.push({ month: new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7), count: 0 });
  }
  const index = new Map(months.map((x, i) => [x.month, i]));
  for (const day of days) {
    const i = index.get(day.date.slice(0, 7));
    if (i !== undefined && day.date <= today) months[i].count += day.contributionCount;
  }
  return months;
}

// A hot month is an outlier: at least twice the average month.
export function hotMonths(counts: number[]): boolean[] {
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  return counts.map((c) => c > 0 && c >= 2 * mean);
}

// Square-root scale, so one huge month doesn't flatten the rest. An empty month keeps a 1px tick.
export function barHeight(count: number, max: number, height: number): number {
  if (count === 0 || max === 0) return 1;
  return Math.max(3, Math.round(Math.sqrt(count / max) * height));
}
