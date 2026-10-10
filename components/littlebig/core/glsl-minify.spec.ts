// The build-time GLSL minifier (scripts/glsl-minify.cjs, a Turbopack loader) must leave every
// shader token-for-token identical: run it over every LITTLEBIG source and compare the token
// streams of each `/* glsl */` literal before and after.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { minifySource, minifyText } = require('../../../scripts/glsl-minify.cjs') as {
  minifySource(src: string): string;
  minifyText(text: string): string;
};

const ROOT = path.resolve(__dirname, '..');
const OPS = ['<<=', '>>=', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '==', '!=', '<=', '>=', '&&', '||', '^^', '<<', '>>'];

/** GLSL tokens of a literal body (interpolations kept as their source text), with preprocessor
 *  lines as single tokens and floats normalised (1.0 ≡ 1.). */
function tokens(body: string): string[] {
  const out: string[] = [];
  const text = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#')) {
      out.push(t.replace(/\s+/g, ' '));
      continue;
    }
    let i = 0;
    while (i < t.length) {
      const c = t[i];
      if (/\s/.test(c)) i++;
      else if (t.startsWith('${', i)) {
        let d = 0;
        let j = i;
        for (; j < t.length; j++) {
          if (t[j] === '{') d++;
          else if (t[j] === '}' && --d === 0) break;
        }
        out.push(t.slice(i, j + 1));
        i = j + 1;
      } else if (/\d/.test(c) || (c === '.' && /\d/.test(t[i + 1] ?? ''))) {
        const m = /^(\d*\.\d*|\d+)([eE][+-]?\d+)?[uUfF]?/.exec(t.slice(i))!;
        out.push(m[0].includes('.') || m[2] ? `f${Number(m[0].replace(/[uUfF]$/, ''))}` : `i${m[0]}`);
        i += m[0].length;
      } else if (/[A-Za-z_]/.test(c)) {
        const m = /^\w+/.exec(t.slice(i))!;
        out.push(m[0]);
        i += m[0].length;
      } else {
        const op = OPS.find((o) => t.startsWith(o, i)) ?? c;
        out.push(op);
        i += op.length;
      }
    }
  }
  return out;
}

/** Bodies of every `/* glsl *\/` literal, in order (naive scan, fine for these sources). */
function literals(src: string): string[] {
  return spans(src).map(([a, b]) => src.slice(a, b));
}

/** [start, end) of every tagged literal body. */
function spans(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /\/\*\s*glsl\s*\*\/\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '$' && src[i + 1] === '{') depth++, i++;
      else if (c === '}' && depth > 0) depth--;
      else if (c === '`' && depth === 0) break;
    }
    out.push([start, i]);
  }
  return out;
}

/** The source with every tagged literal body cut out. */
function outside(src: string): string {
  let out = '';
  let last = 0;
  for (const [a, b] of spans(src)) {
    out += src.slice(last, a);
    last = b;
  }
  return out + src.slice(last);
}

const files = (fs.readdirSync(ROOT, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

describe('glsl minify loader', () => {
  it('keeps every tagged shader token-for-token, preprocessor lines on their own line', () => {
    let before = 0;
    let after = 0;
    let n = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const min = minifySource(src);
      const a = literals(src);
      const b = literals(min);
      expect(b.length, f).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        expect(tokens(b[i]), `${f} literal ${i}`).toEqual(tokens(a[i]));
        for (const line of b[i].split('\n')) if (line.includes('#')) expect(line.trimStart()[0], `${f}: ${line}`).toBe('#');
        before += a[i].length;
        after += b[i].length;
        n++;
      }
      // Outside the literals nothing changes.
      expect(outside(min), f).toBe(outside(src));
    }
    expect(n).toBeGreaterThan(50);
    expect(after).toBeLessThan(before * 0.85);
  });

  it('never fuses signs or touches interpolation edges', () => {
    expect(minifyText('a = b - -c;\nd = e + +f;')).toBe('a=b- -c;d=e+ +f;');
    expect(minifyText('x = y - @@0@@;')).toBe('x=y- @@0@@;');
    expect(minifyText('\n#define F (x)\nfloat g = 1.0 + 0.50; // c\n')).toBe('\n#define F (x)\nfloat g=1.+.5;\n');
    expect(minifyText('v = 1.5e-3 * a1.x + 10.0;')).toBe('v=1.5e-3*a1.x+10.;');
  });
});
