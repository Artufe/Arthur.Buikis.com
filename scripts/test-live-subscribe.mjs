// Live smoke test for the subscribe form. Runs against prod by default;
// pass a different URL as the first arg to point at staging or local.
//
//   node scripts/test-live-subscribe.mjs
//   node scripts/test-live-subscribe.mjs http://localhost:3000/subscribe/
//
// Captures every outbound POST so you can confirm the form actually
// reached the configured newsletter provider.

import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'https://arthur.buikis.com/subscribe/';
const email = process.env.SUBSCRIBE_TEST_EMAIL ?? `headless-test+${Date.now()}@example.com`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newContext().then((ctx) => ctx.newPage());

const networkEvents = [];

// Catch every form-submit; we don't know which provider is wired in.
page.on('request', (req) => {
  if (req.method() === 'POST') {
    networkEvents.push({ kind: 'request', url: req.url(), method: req.method() });
  }
});

page.on('response', async (res) => {
  if (res.request().method() === 'POST') {
    let body = '';
    try { body = await res.text(); } catch {}
    networkEvents.push({
      kind: 'response',
      url: res.url(),
      status: res.status(),
      body: body.slice(0, 500),
    });
  }
});

page.on('requestfailed', (req) => {
  if (req.method() === 'POST') {
    networkEvents.push({
      kind: 'failed',
      url: req.url(),
      failure: req.failure(),
    });
  }
});

console.log(`→ Loading ${url}`);
await page.goto(url, { waitUntil: 'networkidle' });

const submitBtn = page.getByRole('button', { name: /subscribe/i });
if (!(await submitBtn.count())) {
  console.error('✗ No subscribe button found — site.subscribeEndpoint is probably empty.');
  await browser.close();
  process.exit(1);
}

console.log(`→ Filling form with ${email}`);
// Wait past the 800ms client-side dwell trap so the POST actually fires.
await page.waitForTimeout(1200);
await page.fill('input[name="email"]', email);

console.log('→ Submitting');
await submitBtn.click();

console.log('→ Waiting for response...');
await page.waitForTimeout(6000);

console.log('\n================ NETWORK ================');
console.log(JSON.stringify(networkEvents, null, 2));

console.log('\n================ VISIBLE STATE ================');
const visible = await page.evaluate(() => {
  // role="status" wrapper renders both success and error inside it.
  const status = document.querySelector('[role="status"]');
  return { status: status?.textContent?.trim() ?? null };
});
console.log(JSON.stringify(visible, null, 2));

await browser.close();
