import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newContext().then((ctx) => ctx.newPage());

const networkEvents = [];

page.on('request', (req) => {
  if (req.url().includes('formspree.io')) {
    networkEvents.push({ kind: 'request', url: req.url(), method: req.method() });
  }
});

page.on('response', async (res) => {
  if (res.url().includes('formspree.io')) {
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
  if (req.url().includes('formspree.io')) {
    networkEvents.push({
      kind: 'failed',
      url: req.url(),
      failure: req.failure(),
    });
  }
});

console.log('→ Loading contact page');
await page.goto('https://arthur.buikis.com/contact/', { waitUntil: 'networkidle' });

console.log('→ Filling form');
await page.fill('input[name="name"]', 'Headless Test');
await page.fill('input[name="email"]', 'headless-test@example.com');
await page.fill('textarea[name="message"]', 'Automated live test from Playwright — please ignore.');

console.log('→ Submitting');
await page.click('button[type="submit"]');

console.log('→ Waiting for response...');
await page.waitForTimeout(6000);

console.log('\n================ FORMSPREE TRAFFIC ================');
console.log(JSON.stringify(networkEvents, null, 2));

console.log('\n================ VISIBLE PAGE STATE ================');
const visible = await page.evaluate(() => {
  const success = document.querySelector('p.italic');
  const error = document.querySelector('p.text-red-500');
  return { success: success?.textContent ?? null, error: error?.textContent ?? null };
});
console.log(JSON.stringify(visible, null, 2));

await browser.close();
