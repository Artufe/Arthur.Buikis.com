'use client';

import { openPalette } from '@/lib/palette-bus';
import type { GitStats } from '@/lib/git-stats';

type Tone = 'live' | 'amber' | 'neutral';

type Chip = {
  label: string;
  value: string;
  meta: string;
  tone: Tone;
};

function toneDotClass(tone: Tone) {
  if (tone === 'live') return 'live-dot';
  if (tone === 'amber') return 'amber-dot';
  return 'inline-block h-[6px] w-[6px] rounded-full bg-[var(--fg-faint)]';
}

function buildChips(g: GitStats): Chip[] {
  const deploy: Chip = g.available
    ? {
        label: 'Deploy',
        value: g.shortSha,
        meta: g.ageLabel ? `${g.ageLabel} · master` : 'master',
        tone: g.isStale ? 'amber' : 'live',
      }
    : { label: 'Deploy', value: 'master', meta: 'github pages · auto', tone: 'live' };

  const activity: Chip = g.isStale || !g.available
    ? {
        label: 'Activity',
        value: 'quiet here lately',
        meta: 'still around · email me',
        tone: 'amber',
      }
    : {
        label: 'Activity',
        value: `${g.commitsLast30d} commit${g.commitsLast30d === 1 ? '' : 's'} · 30d`,
        meta: g.latestSubject || 'commits trickle in',
        tone: 'live',
      };

  return [
    deploy,
    activity,
    { label: 'Repo', value: 'artufe.github.io', meta: 'source · public', tone: 'amber' },
    { label: 'Uptime', value: '99.9% · 30d', meta: 'cdn · no trackers', tone: 'neutral' },
  ];
}

export function HeroMonitor({ gitStats }: { gitStats: GitStats }) {
  const chips = buildChips(gitStats);

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
        {chips.map((chip) => (
          <div key={chip.label} className="bg-[var(--bg)] p-3.5 flex flex-col gap-1.5">
            <span className="flex items-center gap-2 lbl">
              <span className={toneDotClass(chip.tone)} />
              {chip.label}
            </span>
            <span className="font-mono text-[12px] text-[var(--fg)] leading-snug">{chip.value}</span>
            <span className="font-mono text-[10px] text-[var(--fg-faint)]">{chip.meta}</span>
          </div>
        ))}
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
