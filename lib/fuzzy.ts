export type FuzzyMatch = {
  score: number;
  indices: number[];
};

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      qi++;
    }
  }
  if (qi < q.length) return null;

  let score = 0;
  score -= indices[0];
  for (let i = 1; i < indices.length; i++) {
    const gap = indices[i] - indices[i - 1] - 1;
    score -= gap;
  }
  score -= target.length - q.length;

  return { score, indices };
}

export function highlightMatch(text: string, indices: number[]): { char: string; hit: boolean }[] {
  const set = new Set(indices);
  return [...text].map((ch, i) => ({ char: ch, hit: set.has(i) }));
}
