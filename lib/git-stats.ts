import { execSync } from 'node:child_process';

export type GitStats = {
  shortSha: string;
  ageLabel: string;
  isStale: boolean;
  commitsLast30d: number;
  latestSubject: string;
  available: boolean;
};

const FALLBACK: GitStats = {
  shortSha: 'master',
  ageLabel: '',
  isStale: true,
  commitsLast30d: 0,
  latestSubject: '',
  available: false,
};

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  if (months >= 1) return `${months}mo ago`;
  if (days >= 1) return `${days}d ago`;
  if (hours >= 1) return `${hours}h ago`;
  if (minutes >= 1) return `${minutes}m ago`;
  return 'just now';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function getGitStats(): GitStats {
  try {
    const shortSha = git('rev-parse --short HEAD');
    const dateIso = git('log -1 --format=%cI');
    const subject = git('log -1 --format=%s');

    const date = new Date(dateIso);
    if (Number.isNaN(date.getTime())) return FALLBACK;

    const ageMs = Date.now() - date.getTime();
    const days = ageMs / (1000 * 60 * 60 * 24);
    const isStale = days > 30;

    let commitsLast30d = 0;
    try {
      const log = git('log --since=30.days --pretty=format:%H');
      commitsLast30d = log.length > 0 ? log.split('\n').length : 0;
    } catch {
      commitsLast30d = 0;
    }

    return {
      shortSha,
      ageLabel: formatAge(ageMs),
      isStale,
      commitsLast30d,
      latestSubject: truncate(subject, 36),
      available: true,
    };
  } catch {
    return FALLBACK;
  }
}
