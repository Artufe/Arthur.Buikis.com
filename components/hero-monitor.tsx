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
    value: "Art's Site",
    meta: 'source · public',
    tone: 'amber',
    href: 'https://github.com/Artufe/Arts-site',
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
      className="relative border border-[var(--rule)] bg-[color-mix(in_srgb,var(--bg-muted)_70%,var(--bg)_30%)] font-mono text-[12.5px] overflow-hidden"
      style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' }}
    >
      <div className="flex items-center justify-between px-[18px] py-3.5 border-b border-[var(--rule)] text-[var(--fg-faint)]">
        <span className="lbl">System</span>
        <span className="inline-flex items-center gap-2 text-[11px] tracking-wider text-[var(--live)] lowercase">
          <span className="live-dot" />
          live
        </span>
      </div>

      <div className="grid grid-cols-2">
        {chips.map((chip, i) => {
          const isRight = i % 2 === 1;
          const isLastRow = i >= chips.length - 2;
          const inner = (
            <>
              <span className="flex items-center gap-2 lbl">
                <span className={toneDotClass(chip.tone)} />
                {chip.label}
              </span>
              <span className="text-[15px] text-[var(--fg)] leading-snug flex items-baseline gap-2 group-hover:text-[var(--accent)] transition-colors duration-[var(--dur-fast)]">
                {chip.value}
                {chip.href && <span className="ml-1 text-[11px] text-[var(--fg-faint)] group-hover:text-[var(--accent)]">↗</span>}
              </span>
              <span className="text-[11px] text-[var(--fg-muted)] leading-relaxed">{chip.meta}</span>
            </>
          );
          const classes = [
            'p-5 flex flex-col gap-1.5',
            isRight ? '' : 'border-r border-[var(--rule)]',
            isLastRow ? '' : 'border-b border-[var(--rule)]',
          ].join(' ');
          if (chip.href) {
            return (
              <a
                key={chip.label}
                href={chip.href}
                target="_blank"
                rel="noreferrer"
                className={`group ${classes} focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]`}
              >
                {inner}
              </a>
            );
          }
          return (
            <div key={chip.label} className={classes}>
              {inner}
            </div>
          );
        })}
      </div>

      <div className="border-t border-[var(--rule)] px-[18px] py-4 flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <span className="lbl mb-1.5 block">Currently</span>
          <p className="font-serif italic text-[18px] leading-[1.35] text-[var(--fg)] text-wrap-pretty">
            Heads-down on API perf — indexes, rewrites, the usual.
          </p>
        </div>
        <button
          type="button"
          onClick={() => openPalette()}
          aria-label="Open command palette"
          className="shrink-0 inline-flex items-center gap-2 px-2.5 py-1.5 border border-[var(--rule)] text-[11px] text-[var(--fg-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition-colors duration-[var(--dur-fast)]"
        >
          <span className="kbd">/</span>
          commands
        </button>
      </div>
    </div>
  );
}
