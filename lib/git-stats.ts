import { execSync } from 'node:child_process';

export type GitStats = {
  shortSha: string;
  latestSubject: string;
  commitIso: string;
  recentCommitIsos: string[];
  builtAtIso: string;
  available: boolean;
};

const FALLBACK: GitStats = {
  shortSha: 'master',
  latestSubject: '',
  commitIso: '',
  recentCommitIsos: [],
  builtAtIso: '',
  available: false,
};

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
    const commitIso = git('log -1 --format=%cI');
    const subject = git('log -1 --format=%s');
    if (Number.isNaN(new Date(commitIso).getTime())) return FALLBACK;

    let recentCommitIsos: string[] = [];
    try {
      // Wider buffer than the 30d window so the rolling count stays accurate
      // even when the page is viewed weeks after the most recent deploy.
      const log = git('log --since=60.days --pretty=format:%cI');
      recentCommitIsos = log.length > 0 ? log.split('\n') : [];
    } catch {
      recentCommitIsos = [];
    }

    return {
      shortSha,
      latestSubject: truncate(subject, 36),
      commitIso,
      recentCommitIsos,
      builtAtIso: new Date().toISOString(),
      available: true,
    };
  } catch {
    return FALLBACK;
  }
}
