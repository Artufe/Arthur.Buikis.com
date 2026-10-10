// Build-time GLSL minifier for LITTLEBIG (a Turbopack loader, registered in next.config.mjs).
//
// The JS minifier keeps template literals verbatim, so every shader shipped its indentation,
// comments and line breaks. This rewrites the static text of each template literal tagged
// `/* glsl */` in the source: comments go, whitespace collapses, spaces next to punctuation go,
// and float literals lose redundant zeros (1.0 → 1., 0.5 → .5). Token-for-token the shader is the
// same (components/littlebig/core/glsl-minify.spec.ts checks that over every tagged literal).
//
// Rules that keep it safe:
// - `${…}` interpolations are never touched; a line that holds one keeps its own line, and no space
//   next to it is removed where the value could start or end with a sign.
// - Preprocessor lines (#include, #define, #if…) keep their own line, only whitespace-collapsed
//   (three's #include expansion and the unroll pragma match at line starts; `#define F (x)` must
//   not become a function-like macro).
// - A literal that started (ended) with a line break still does, so concatenated chunks stay
//   separated.
'use strict';

const OPEN = /\/\*\s*glsl\s*\*\/\s*`/g;

/** Index just past the template literal whose body starts at `i` (after the opening backtick), plus
 *  its parts: static strings and the raw interpolation sources between them. */
function scanTemplate(src, i) {
  const statics = [];
  const exprs = [];
  let cur = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      cur += c + src[i + 1];
      i += 2;
    } else if (c === '`') {
      statics.push(cur);
      return { end: i + 1, statics, exprs };
    } else if (c === '$' && src[i + 1] === '{') {
      const start = i;
      i = skipExpr(src, i + 2);
      statics.push(cur);
      exprs.push(src.slice(start, i));
      cur = '';
    } else {
      cur += c;
      i++;
    }
  }
  throw new Error('glsl-minify: unterminated template literal');
}

/** Index just past the `}` closing an interpolation whose body starts at `i`. */
function skipExpr(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      if (--depth === 0) return i + 1;
    } else if (c === '`') {
      i = scanTemplate(src, i + 1).end;
      continue;
    } else if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
    }
    i++;
  }
  throw new Error('glsl-minify: unterminated interpolation');
}

const PH = (n) => `@@${n}@@`;
const PH_RE = /@@(\d+)@@/g;

/** Shorten float literals: 1.0 → 1., 0.5 → .5, 2.50 → 2.5 (never inside identifiers). */
function floats(s) {
  return s.replace(/(?<![\w.@])(\d+)\.(\d+)(?![\w.])/g, (m, a, b) => {
    b = b.replace(/0+$/, '');
    a = a.replace(/^0+(?=\d)/, '');
    if (a === '0' && b) return '.' + b;
    return a + '.' + b;
  });
}

/** Minify one GLSL text in which interpolations are already `@@n@@` placeholders. */
function minifyText(text) {
  // Keep the literal's edges: a leading/trailing line break stays one, other whitespace one space.
  const lead = /^\s*/.exec(text)[0];
  const trail = /\s*$/.exec(text)[0];
  const edge = (ws) => (ws.includes('\n') ? '\n' : ws ? ' ' : '');
  // Comments (GLSL has no string literals, so these never sit inside one).
  let s = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const out = [];
  let soft = [];
  const flushSoft = () => {
    if (!soft.length) return;
    out.push(tighten(soft.join(' ')));
    soft = [];
  };
  for (let line of s.split('\n')) {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (line[0] === '#') {
      flushSoft();
      out.push(line);
    } else if (line.includes('@@')) {
      flushSoft();
      out.push(tighten(line));
    } else soft.push(line);
  }
  flushSoft();
  if (!out.length) return edge(lead + trail);
  return edge(lead) + out.join('\n') + edge(trail);
}

/** Remove spaces that GLSL does not need (one line, no preprocessor). */
function tighten(s) {
  s = floats(s);
  // Around punctuation that can never fuse with a neighbour into another token.
  s = s.replace(/ ?([{}()[\];,=<>*/?:!&|^%~]) ?/g, '$1');
  // Around + and -, unless that would fuse two signs (a - -b → a--b) or touch an interpolation.
  s = s.replace(/(?<![+\-@]) ([+-])/g, '$1').replace(/([+-]) (?![+\-@])/g, '$1');
  return s;
}

/** Minify every `/* glsl *\/` template literal in a source file. Returns the new source. */
function minifySource(src) {
  let out = '';
  let last = 0;
  OPEN.lastIndex = 0;
  let m;
  while ((m = OPEN.exec(src))) {
    const bodyStart = m.index + m[0].length;
    const t = scanTemplate(src, bodyStart);
    // Leave literals with escapes alone (none today): their raw text is not the shader text.
    if (t.statics.some((x) => x.includes('\\') || x.includes('@@'))) {
      OPEN.lastIndex = t.end;
      continue;
    }
    const joined = t.statics.map((x, i) => x + (i < t.exprs.length ? PH(i) : '')).join('');
    const min = minifyText(joined).replace(PH_RE, (_, n) => t.exprs[Number(n)]);
    out += src.slice(last, bodyStart) + min + '`';
    last = t.end;
    OPEN.lastIndex = t.end;
  }
  return last === 0 ? src : out + src.slice(last);
}

module.exports = function glslMinifyLoader(source) {
  return minifySource(String(source));
};
module.exports.minifySource = minifySource;
module.exports.minifyText = minifyText;
module.exports.scanTemplate = scanTemplate;
