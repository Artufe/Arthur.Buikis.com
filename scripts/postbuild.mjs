#!/usr/bin/env node
// Patch the next-export output so the OG image ships with a .png extension.
// Background: app/opengraph-image.tsx emits a binary at out/opengraph-image
// (extensionless). GitHub Pages serves that as application/octet-stream,
// which OG/Twitter scrapers reject. Rename it and rewrite the URL in HTML.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('out');
const SRC = path.join(ROOT, 'opengraph-image');
const DEST = path.join(ROOT, 'opengraph-image.png');

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(full)));
    else if (e.isFile() && full.endsWith('.html')) files.push(full);
  }
  return files;
}

if (!(await exists(SRC))) {
  console.error(`[postbuild] expected ${SRC} to exist; skipping`);
  process.exit(0);
}

await fs.copyFile(SRC, DEST);
await fs.unlink(SRC);

const html = await walk(ROOT);
const RE = /\/opengraph-image(\?[^"'\s)]*)?/g;
let patched = 0;
for (const file of html) {
  const before = await fs.readFile(file, 'utf-8');
  const after = before.replace(RE, '/opengraph-image.png');
  if (after !== before) {
    await fs.writeFile(file, after, 'utf-8');
    patched++;
  }
}

console.log(`[postbuild] og image renamed → opengraph-image.png; patched ${patched}/${html.length} html files`);
