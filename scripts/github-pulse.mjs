#!/usr/bin/env node
// Refreshes content/github-pulse.json, the data behind the header's GitHub pulse
// (components/github-pulse.tsx). deploy.yml runs it before every build, including the daily
// scheduled one. Locally (to refresh the committed snapshot):
//   GITHUB_TOKEN=$(gh auth token) node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/github-pulse.mjs
//
// Without a token, or when the API fails, it keeps the committed snapshot and exits 0: a GitHub
// hiccup never blocks a deploy, it just ships yesterday's numbers.
import fs from 'node:fs';
import { toMonths } from '../lib/github-pulse.ts';

const LOGIN = 'Artufe';
const OUT = new URL('../content/github-pulse.json', import.meta.url);
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

const query = `query ($login: String!) {
  user(login: $login) {
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

if (!token) {
  console.warn('[github-pulse] no GITHUB_TOKEN; keeping the committed snapshot');
  process.exit(0);
}

try {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { login: LOGIN } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json).slice(0, 300));

  const c = json.data.user.contributionsCollection;
  const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  const today = days.at(-1).date;
  const pulse = {
    login: LOGIN,
    fetchedAt: today,
    total: c.contributionCalendar.totalContributions,
    commits: c.totalCommitContributions,
    pullRequests: c.totalPullRequestContributions,
    months: toMonths(days, today),
  };
  fs.writeFileSync(OUT, JSON.stringify(pulse, null, 2) + '\n');
  console.log(`[github-pulse] ${pulse.total} contributions, ${pulse.commits} commits, ${pulse.pullRequests} PRs (${today})`);
} catch (e) {
  console.warn(`[github-pulse] fetch failed; keeping the committed snapshot: ${e.message}`);
}
