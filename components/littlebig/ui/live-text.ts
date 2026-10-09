// The follow card's live line ('13 km/h · on the plaza loop · turning left onto harbour road'),
// laid out by hand in monospace columns, so it never ends in '…', never spends a whole line on a
// short piece, and breaks a long piece where a reader would ('next stop: / clockwork avenue',
// 'turning left / onto harbour road'). Pure: the card measures how many columns its box holds and
// renders these lines.
//
// Rules (DECISIONS.md [v2-U1f]):
// - Pieces are split on ' · '. The dot stays at the end of its piece, so a line never starts with '·'.
// - A number stays with the word after it ('57 km/h', '69 m'); a piece no longer than BREAK_SHARE of
//   the line is never broken ('on acorn close'); a longer one may break at its spaces, best after a
//   colon or before a preposition.
// - Every layout of at most `maxLines` lines is scored (breaks inside pieces, lines used, how even the
//   lines are) and the cheapest wins. When the whole line does not fit, the last piece (the least
//   important: the heading, then the place) is dropped, never clipped.

/** A piece longer than this share of the line may break at its spaces. */
export const BREAK_SHARE = 0.6;

/** Columns a box `px` wide holds in a monospace face of `fontPx` (advance ≈ 0.6 em). */
export function colsFor(px: number, fontPx: number, advance = 0.6): number {
  return Math.max(1, Math.floor(px / (fontPx * advance)));
}

// Costs (tuned on the real detail() lines in ui.spec.ts).
/** A break inside a piece (only a piece longer than BREAK_SHARE of the line may break at all). */
const COST_BREAK = 6;
/** …right after a colon ('next stop: / clockwork avenue'). */
const COST_AFTER_COLON = 2;
/** …right before a preposition ('turning left / onto harbour road'). */
const COST_BEFORE_PREP = 4;
/** …right after an article ('a / lap every 1:36'): only when nothing else fits. */
const COST_AFTER_ARTICLE = 18;
/** Each line after the first. */
const COST_LINE = 7;
/** Each piece left out (always worse than a break or a line, never worse than a clipped line). */
const COST_DROP = 30;
/** The spread between the longest and the shortest line, per full line of columns. */
const COST_UNEVEN = 3;
/** A stub: a line shorter than STUB of the longest one ('13 km/h ·' alone above a long line). */
const COST_STUB = 2;
const STUB = 0.4;
const PREP = new Set(['onto', 'into', 'to', 'toward', 'towards', 'past', 'from', 'for', 'via', 'at', 'on', 'in', 'over', 'near', 'with', 'by', 'and', 'round', 'around', 'through']);
const ARTICLE = new Set(['a', 'an', 'the']);

interface Word {
  text: string;
  /** Cost of a line break right after this word (Infinity: never). */
  brk: number;
}

/** The kept pieces as words, each with the cost of breaking after it. Null if a word is wider than the line. */
function words(pieces: readonly string[], cols: number): Word[] | null {
  const out: Word[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const tail = i < pieces.length - 1 ? ' ·' : '';
    // Words, a number held to the word after it.
    const ws = p.match(/\d[\d.,:]*\s+\S+|\S+/g) ?? [p];
    const breakable = ws.length > 1 && (p.length > cols * BREAK_SHARE || p.length + tail.length > cols);
    for (let j = 0; j < ws.length; j++) {
      const last = j === ws.length - 1;
      const text = last ? ws[j] + tail : ws[j];
      if (text.length > cols) return null;
      let brk = 0;
      if (!last) {
        const w = ws[j].toLowerCase();
        if (!breakable) brk = Infinity;
        else if (ARTICLE.has(w)) brk = COST_AFTER_ARTICLE;
        else if (w.endsWith(':')) brk = COST_AFTER_COLON;
        else if (PREP.has(ws[j + 1].toLowerCase())) brk = COST_BEFORE_PREP;
        else brk = COST_BREAK;
      }
      out.push({ text, brk });
    }
  }
  return out;
}

/** The cheapest layout of `ws` in at most `maxLines` lines of `cols` columns, or null if none fits. */
function best(ws: readonly Word[], cols: number, maxLines: number): { lines: string[]; cost: number } | null {
  const n = ws.length;
  // Prefix lengths: a line holding words a..b-1 is len[b] - len[a] + (b - a - 1) wide.
  const len = new Array<number>(n + 1);
  len[0] = 0;
  for (let i = 0; i < n; i++) len[i + 1] = len[i] + ws[i].text.length;
  const width = (a: number, b: number) => len[b] - len[a] + (b - a - 1);
  let bestCost = Infinity;
  let bestCuts: number[] = [];
  const cuts: number[] = [];
  // Depth-first over the break positions (at most maxLines − 1 of them; a dozen words: trivial).
  const walk = (start: number, cost: number) => {
    if (cost >= bestCost) return;
    if (width(start, n) <= cols) {
      // The rest fits on this line: score the whole layout.
      let total = cost;
      if (cuts.length > 0) {
        let lo = Infinity;
        let hi = 0;
        let a = 0;
        for (let i = 0; i <= cuts.length; i++) {
          const c = i < cuts.length ? cuts[i] : n;
          const w = width(a, c);
          lo = Math.min(lo, w);
          hi = Math.max(hi, w);
          a = c;
        }
        total += (COST_UNEVEN * (hi - lo)) / cols + (lo < hi * STUB ? COST_STUB : 0);
      }
      if (total < bestCost) {
        bestCost = total;
        bestCuts = cuts.slice();
      }
    }
    if (cuts.length + 1 >= maxLines) return;
    for (let b = start + 1; b < n && width(start, b) <= cols; b++) {
      const k = ws[b - 1].brk;
      if (k === Infinity) continue;
      cuts.push(b);
      walk(b, cost + k + COST_LINE);
      cuts.pop();
    }
  };
  walk(0, 0);
  if (bestCost === Infinity) return null;
  const lines: string[] = [];
  let a = 0;
  for (const c of [...bestCuts, n]) {
    lines.push(ws.slice(a, c).map((w) => w.text).join(' '));
    a = c;
  }
  return { lines, cost: bestCost };
}

/**
 * The live line in at most `maxLines` lines of `cols` monospace columns. Never ends in '…' unless a
 * single word of the first piece is wider than the box.
 */
export function layoutLive(text: string, cols: number, maxLines: number): string[] {
  const pieces = text
    .split(' · ')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!pieces.length) return [];
  const C = Math.max(4, Math.floor(cols));
  const L = Math.max(1, Math.floor(maxLines));
  let pick: { lines: string[]; cost: number } | null = null;
  for (let keep = pieces.length; keep >= 1; keep--) {
    const drop = (pieces.length - keep) * COST_DROP;
    // Fewer pieces only ever cost more than this: stop once a kept layout beats the drop.
    if (pick && pick.cost <= drop) break;
    const ws = words(pieces.slice(0, keep), C);
    const b = ws && best(ws, C, L);
    if (b && (!pick || b.cost + drop < pick.cost)) pick = { lines: b.lines, cost: b.cost + drop };
  }
  if (pick) return pick.lines;
  // The first piece alone does not fit (a word wider than the box, or too many words for the
  // lines): filled greedily, an overlong word cut hard, the last line ending in an ellipsis.
  const lines: string[] = [];
  let cur = '';
  for (const w of pieces[0].split(/\s+/)) {
    cur = !cur ? w : cur.length + 1 + w.length <= C ? `${cur} ${w}` : (lines.push(cur), w);
    while (cur.length > C) {
      lines.push(cur.slice(0, C));
      cur = cur.slice(C);
    }
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, L);
  const last = out[out.length - 1];
  out[out.length - 1] = `${last.slice(0, C - 1).trimEnd()}…`;
  return out;
}
