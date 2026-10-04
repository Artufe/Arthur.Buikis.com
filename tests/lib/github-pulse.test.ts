import { describe, it, expect } from 'vitest';
import { hotMonths, toMonths } from '@/lib/github-pulse';

describe('github pulse data', () => {
  it('buckets calendar days into the 12 months ending with the current one', () => {
    const months = toMonths(
      [
        { date: '2025-10-31', contributionCount: 9 }, // before the window
        { date: '2025-11-01', contributionCount: 2 },
        { date: '2025-11-30', contributionCount: 3 },
        { date: '2026-10-04', contributionCount: 4 },
        { date: '2026-10-05', contributionCount: 7 }, // after today
      ],
      '2026-10-04',
    );
    expect(months.map((m) => m.month)).toEqual([
      '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04',
      '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(months[0].count).toBe(5);
    expect(months[11].count).toBe(4);
    expect(months.reduce((a, m) => a + m.count, 0)).toBe(9);
  });

  it('marks months at least twice the average as hot', () => {
    // Real Nov 2025 – Oct 2026: average 21.4, so Apr (44), May (105) and Sep (47) are hot.
    expect(hotMonths([6, 6, 7, 1, 0, 44, 105, 0, 0, 31, 47, 10])).toEqual([
      false, false, false, false, false, true, true, false, false, false, true, false,
    ]);
  });
});
