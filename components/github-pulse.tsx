import snapshot from '@/content/github-pulse.json';
import { barHeight, hotMonths, type Pulse } from '@/lib/github-pulse';
import { cn } from '@/lib/utils';

const BAR_H = 26;

// The header card beside the brand: one bar per month for the last 12 months (hot months in the
// accent), with the headline numbers to the right. Data: content/github-pulse.json, refreshed by
// scripts/github-pulse.mjs on every deploy.
export function GithubPulse({ data = snapshot as Pulse }: { data?: Pulse }) {
  const counts = data.months.map((m) => m.count);
  const max = Math.max(...counts);
  const hot = hotMonths(counts);

  return (
    <a
      href={`https://github.com/${data.login}`}
      target="_blank"
      rel="noreferrer"
      className="pulse"
      aria-label={`GitHub: ${data.total} contributions in the last year, ${data.commits} commits, ${data.pullRequests} pull requests`}
    >
      <span className="pulse-bars" aria-hidden="true">
        {data.months.map((m, i) => (
          <span
            key={m.month}
            data-month={m.month}
            data-count={m.count}
            className={cn(hot[i] && 'hot')}
            style={{ height: barHeight(m.count, max, BAR_H) }}
          />
        ))}
      </span>
      <span className="pulse-text" aria-hidden="true">
        <span>
          <b>{data.total}</b>
          <span className="pulse-long"> contributions · 12 mo</span>
          <span className="pulse-short"> / yr</span>
        </span>
        <span>
          {data.commits} commits<span className="pulse-long"> · {data.pullRequests} prs</span>
        </span>
      </span>
    </a>
  );
}
