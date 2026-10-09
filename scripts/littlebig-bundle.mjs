// Measure the actual exported route, including lazy imports. Both totals are enforced:
// all incremental JS (robust to chunk merging) and own JS (three-only chunks excluded).
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve('out');
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
    if (!file.startsWith(root + sep)) throw new Error('outside export');
    const content = await readFile(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] ?? 'application/octet-stream');
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ args: process.platform === 'darwin'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  async function load(route) {
    const page = await browser.newPage();
    const seen = new Set();
    page.on('request', (r) => { if (new URL(r.url()).pathname.endsWith('.js')) seen.add(r.url()); });
    await page.goto(base + route);
    if (route === '/planet/') await page.locator('.lbh-dock').waitFor({ timeout: 90_000 });
    await page.waitForLoadState('networkidle');
    await page.close();
    return seen;
  }
  const common = await load('/about/');
  const planet = await load('/planet/');
  let own = 0, total = 0, chunks = 0;
  for (const url of planet) {
    if (common.has(url)) continue;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Cannot read ${url}`);
    const source = await response.text();
    const gzip = gzipSync(source, { level: 9 }).length;
    const threeOnly = /ShaderChunk|ShaderLib|Matrix4/.test(source) && !/\[littlebig\]|lbCamAlt|walkEdges/.test(source);
    total += gzip;
    if (!threeOnly) own += gzip;
    chunks++;
    console.log(`${(gzip / 1024).toFixed(1)} KiB gzip ${threeOnly ? 'three' : 'own'} ${new URL(url).pathname}`);
  }
  if (!chunks || own < 100 * 1024) throw new Error('Incomplete planet load: refusing a false budget pass');
  // Current feature-complete baseline 415.0 / 579.5 KiB (v2 towns and roads added 43 KiB, the
  // bird's flight model and animation 9.3, the region's traffic and the townsfolk 42). The
  // historical 260 KiB own-JS aspiration remains documented in PERF.md; these are explicit
  // no-regression ceilings, raised only with a measured entry in DECISIONS.md.
  const ownLimit = Number(process.env.LB_OWN_KIB ?? 423);
  const totalLimit = Number(process.env.LB_TOTAL_KIB ?? 592);
  if (!(ownLimit > 0 && totalLimit > 0)) throw new Error('Budgets must be positive numbers');
  console.log(`Planet: ${(own / 1024).toFixed(1)} / ${ownLimit} KiB own; ${(total / 1024).toFixed(1)} / ${totalLimit} KiB total incremental gzip`);
  if (own > ownLimit * 1024 || total > totalLimit * 1024) throw new Error('Planet bundle budget exceeded');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
