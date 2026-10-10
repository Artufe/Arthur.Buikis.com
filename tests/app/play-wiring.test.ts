import { describe, it, expect } from 'vitest';
import sitemap from '@/app/sitemap';
import { GET as llms } from '@/app/llms.txt/route';
import { GET as llmsFull } from '@/app/llms-full.txt/route';
import { site } from '@/content/site';

const base = site.url.replace(/\/$/, '');

describe('/play wiring', () => {
  it('puts Play in the nav right after Building', () => {
    const labels = site.nav.map((n) => n.label);
    expect(labels.indexOf('Play')).toBe(labels.indexOf('Building') + 1);
  });

  it('lists /play/ in the sitemap and both llms routes', async () => {
    expect((await sitemap()).map((e) => e.url)).toContain(`${base}/play/`);
    expect(await (await llms()).text()).toContain(`${base}/play/`);
    expect(await (await llmsFull()).text()).toContain(`${base}/play/`);
  });

  it('lists the LITTLEBIG page in the sitemap and both llms routes', async () => {
    expect((await sitemap()).map((e) => e.url)).toContain(`${base}/planet/`);
    expect(await (await llms()).text()).toContain(`${base}/planet/`);
    expect(await (await llmsFull()).text()).toContain(`${base}/planet/`);
  });
});
