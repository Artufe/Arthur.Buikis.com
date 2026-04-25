'use client';

import { useSyncExternalStore } from 'react';
import { openPalette } from '@/lib/palette-bus';
import type { GitStats } from '@/lib/git-stats';

type Tone = 'live' | 'amber' | 'neutral';

type Chip = {
  label: string;
  value: string;
  meta: string;
  tone: Tone;
  href?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60_000;
const SERVER_TIME = -1;

let clientNow: number | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  if (clientNow === null) {
    clientNow = Date.now();
    queueMicrotask(notify);
  }
  if (intervalId === null) {
    intervalId = setInterval(() => {
      clientNow = Date.now();
      notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function getSnapshot() {
  return clientNow ?? SERVER_TIME;
}

function getServerSnapshot() {
  return SERVER_TIME;
}

function toneDotClass(tone: Tone) {
  if (tone === 'live') return 'live-dot';
  if (tone === 'amber') return 'amber-dot';
  return 'inline-block h-[6px] w-[6px] rounded-full bg-[var(--fg-faint)]';
}

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

function buildChips(g: GitStats, now: number): Chip[] {
  const repoChip: Chip = {
    label: 'Repo',
    value: 'artufe.github.io',
    meta: 'source · public',
    tone: 'amber',
    href: 'https://github.com/Artufe/Artufe.github.io',
  };
  const uptimeChip: Chip = {
    label: 'Uptime',
    value: '99.9% · 30d',
    meta: 'cdn · no trackers',
    tone: 'neutral',
  };

  if (!g.available) {
    return [
      { label: 'Deploy', value: 'master', meta: 'github pages · auto', tone: 'live' },
      { label: 'Activity', value: 'quiet here lately', meta: 'still around · email me', tone: 'amber' },
      repoChip,
      uptimeChip,
    ];
  }

  const ageMs = Math.max(0, now - new Date(g.commitIso).getTime());
  const isStale = ageMs > 30 * DAY_MS;
  const cutoff = now - 30 * DAY_MS;
  const commitsLast30d = g.recentCommitIsos.filter((iso) => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= cutoff;
  }).length;

  const deploy: Chip = {
    label: 'Deploy',
    value: g.shortSha,
    meta: `${formatAge(ageMs)} · master`,
    tone: isStale ? 'amber' : 'live',
  };

  const activity: Chip = isStale
    ? {
        label: 'Activity',
        value: 'quiet here lately',
        meta: 'still around · email me',
        tone: 'amber',
      }
    : {
        label: 'Activity',
        value: `${commitsLast30d} commit${commitsLast30d === 1 ? '' : 's'} · 30d`,
        meta: g.latestSubject || 'commits trickle in',
        tone: 'live',
      };

  return [deploy, activity, repoChip, uptimeChip];
}

export function HeroMonitor({ gitStats }: { gitStats: GitStats }) {
  const t = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const ssrNow = gitStats.builtAtIso ? new Date(gitStats.builtAtIso).getTime() : Date.now();
  const now = t === SERVER_TIME ? ssrNow : t;
  const chips = buildChips(gitStats, now);

  return (
    <div
      className="relative border border-[var(--rule-strong)] bg-[var(--card)] p-5 sm:p-6 flex flex-col gap-4 min-h-[320px]"
      style={{ boxShadow: 'var(--panel-shadow)' }}
    >
      <div className="flex items-center justify-between">
        <span className="lbl">System</span>
        <span className="inline-flex items-center gap-2 font-mono text-[10px] text-[var(--fg-muted)]">
          <span className="live-dot" />
          live
        </span>
      </div>

      <div className="grid grid-cols-2 gap-px bg-[var(--rule-strong)]">
        {chips.map((chip) => {
          const inner = (
            <>
              <span className="flex items-center gap-2 lbl">
                <span className={toneDotClass(chip.tone)} />
                {chip.label}
              </span>
              <span className="font-mono text-[12px] text-[var(--fg)] leading-snug group-hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]">
                {chip.value}
                {chip.href && <span className="ml-1 text-[var(--fg-faint)] group-hover:text-[var(--accent)]">↗</span>}
              </span>
              <span className="font-mono text-[10px] text-[var(--fg-faint)]">{chip.meta}</span>
            </>
          );
          if (chip.href) {
            return (
              <a
                key={chip.label}
                href={chip.href}
                target="_blank"
                rel="noreferrer"
                className="group bg-[var(--bg)] p-3.5 flex flex-col gap-1.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
              >
                {inner}
              </a>
            );
          }
          return (
            <div key={chip.label} className="bg-[var(--bg)] p-3.5 flex flex-col gap-1.5">
              {inner}
            </div>
          );
        })}
      </div>

      <div className="border-t border-[var(--rule-strong)] pt-3.5">
        <span className="lbl mb-2 block">Currently</span>
        <p className="font-serif italic text-[15px] leading-relaxed text-[var(--fg)]/85">
          Heads-down on API perf — indexes, rewrites, the usual.
        </p>
      </div>

      <button
        type="button"
        onClick={() => openPalette()}
        aria-label="Open command palette"
        className="absolute bottom-4 right-4 inline-flex items-center gap-2 font-mono text-[10px] text-[var(--fg-faint)] hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]"
      >
        <span className="kbd">/</span>
        commands
      </button>
    </div>
  );
}
