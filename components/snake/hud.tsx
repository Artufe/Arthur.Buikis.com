'use client';

import { Volume2, VolumeX } from 'lucide-react';
import type { DeathCause, GameStatus } from './engine/types';
import { InitialsEntry } from './initials-entry';
import type { LeaderboardEntry } from './leaderboard';

export type HudPhase = 'none' | 'initials' | 'table';
export type HudView = {
  status: GameStatus;
  score: number;
  best: number;
  length: number;
  deathCause: DeathCause | null;
};

// Drawn over the 3D scene, not the site background: fixed plate + accent that read in both themes.
const PLATE = 'bg-[rgba(14,11,8,0.58)] backdrop-blur-[3px] border border-white/10 text-[#f5ead9]';
const ACCENT = 'text-[#ffb84d]';
const LABEL = 'text-[10px] uppercase tracking-[0.2em] text-[#f5ead9]/60';

type Props = {
  view: HudView;
  phase: HudPhase;
  entries: LeaderboardEntry[];
  rank: number;
  muted: boolean;
  touch: boolean;
  lastInitials: string;
  onToggleSound: () => void;
  onSubmitInitials: (initials: string) => void;
};

export function Hud(props: Props) {
  const { view, muted, onToggleSound } = props;
  return (
    <div className="pointer-events-none absolute inset-0 select-none font-mono">
      <div className={`absolute left-3 top-3 px-3 py-1.5 ${PLATE}`}>
        <div className={LABEL}>score</div>
        <div className={`text-[22px] font-bold leading-none ${ACCENT}`}>{view.score}</div>
      </div>
      <div className="absolute right-3 top-3 flex items-start gap-2">
        <div className={`px-3 py-1.5 text-right ${PLATE}`}>
          <div className={LABEL}>best</div>
          <div className="text-[22px] font-bold leading-none">{Math.max(view.best, view.score)}</div>
        </div>
        <button
          type="button"
          onClick={onToggleSound}
          aria-label={muted ? 'turn sound on' : 'turn sound off'}
          aria-pressed={!muted}
          className={`pointer-events-auto p-2 ${PLATE} hover:text-[#ffb84d]`}
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      </div>
      {view.status === 'idle' && <IdlePanel {...props} />}
      {view.status === 'paused' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className={`px-5 py-3 text-[13px] uppercase tracking-[0.3em] ${PLATE}`}>paused</div>
        </div>
      )}
      {view.status === 'gameover' && props.phase !== 'none' && <GameOverPanel {...props} />}
    </div>
  );
}

// Sits high, below the corner boxes, so the snake and food below stay in view.
function IdlePanel({ touch, entries }: Props) {
  return (
    <div className="absolute inset-x-0 top-[68px] flex justify-center px-4">
      <div className={`w-full max-w-[340px] px-4 py-3 text-center ${PLATE}`}>
        <div className={`text-[24px] font-bold leading-none tracking-[0.35em] ${ACCENT}`}>SNAKE</div>
        <div className="mt-2 text-[11px] leading-snug text-[#f5ead9]/85">
          {touch ? 'drag anywhere to steer · tap to start' : 'arrows, wasd or mouse to steer · press a key to start'}
        </div>
        {entries.length > 0 && <Table entries={entries.slice(0, 3)} rank={-1} compact />}
        {!touch && <div className="mt-2 text-[10px] text-[#f5ead9]/50">space pause · r restart · m sound</div>}
      </div>
    </div>
  );
}

function GameOverPanel({ view, phase, entries, rank, touch, lastInitials, onSubmitInitials }: Props) {
  const cause = view.deathCause === 'self' ? 'bit your own tail' : 'hit the rocks';
  const record = entries.length === 0 || view.score > entries[0].score;
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/25 px-4">
      <div className={`w-full max-w-[380px] px-5 py-4 ${PLATE}`}>
        <div className="text-center text-[11px] uppercase tracking-[0.3em] text-[#f5ead9]/60">{cause}</div>
        <div className="mt-2 flex justify-center gap-6 text-center">
          <Stat label="score" value={view.score} accent />
          <Stat label="length" value={view.length.toFixed(1)} />
          <Stat label="best" value={Math.max(view.best, view.score)} />
        </div>
        {phase === 'initials' ? (
          <div className="pointer-events-auto mt-4">
            <InitialsEntry
              initial={lastInitials}
              onSubmit={onSubmitInitials}
              title={record ? 'new high score — your initials' : 'top 10 — your initials'}
            />
          </div>
        ) : (
          <Table entries={entries} rank={rank} />
        )}
        {phase === 'table' && (
          <div className={`mt-3 text-center text-[11px] ${ACCENT}`}>
            {touch ? 'tap to play again' : 'press r or click to play again'}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className={`text-[20px] font-bold leading-tight ${accent ? ACCENT : ''}`}>{value}</div>
    </div>
  );
}

const ROW = 'grid grid-cols-[1.5rem_1fr_3.5rem_3rem] gap-x-2 px-2 tabular-nums';

function Table({ entries, rank, compact = false }: { entries: LeaderboardEntry[]; rank: number; compact?: boolean }) {
  if (entries.length === 0) return <div className="mt-4 text-center text-[11px] text-[#f5ead9]/60">no scores yet</div>;
  return (
    <div className={`${compact ? 'mx-auto mt-3 max-w-[240px] text-[11px]' : 'mt-4 text-[12px]'} text-left`}>
      <div className={`${ROW} pb-1 text-[9px] uppercase tracking-[0.18em] text-[#f5ead9]/45`}>
        <span>#</span>
        <span>name</span>
        <span className="text-right">len</span>
        <span className="text-right">score</span>
      </div>
      <ol>
        {entries.map((e, i) => (
          <li
            key={`${e.date}-${i}`}
            className={`${ROW} py-0.5 ${i === rank ? 'bg-[#ffb84d] font-bold text-[#1a1208]' : ''}`}
          >
            <span className="opacity-60">{i + 1}</span>
            <span>{e.initials}</span>
            <span className="text-right opacity-70">{e.length.toFixed(1)}</span>
            <span className={`text-right ${i === rank ? '' : ACCENT}`}>{e.score}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function WebGLFallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center font-mono">
      <div className={`max-w-[360px] px-5 py-4 text-[12px] ${PLATE}`}>
        This game needs WebGL, which isn&apos;t available in this browser.
      </div>
    </div>
  );
}
