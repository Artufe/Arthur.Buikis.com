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
      {view.status === 'gameover' && <GameOverPanel {...props} />}
    </div>
  );
}

function IdlePanel({ touch, entries }: Props) {
  return (
    <div className="absolute inset-x-0 bottom-6 flex justify-center px-4">
      <div className={`w-full max-w-[420px] px-5 py-4 text-center ${PLATE}`}>
        <div className={`text-[28px] font-bold tracking-[0.35em] ${ACCENT}`}>SNAKE</div>
        <div className="mt-1 text-[11px] text-[#f5ead9]/80">
          {touch ? 'drag anywhere to steer · tap to start' : 'arrows, wasd or the mouse to steer · press a direction or click to start'}
        </div>
        {entries.length > 0 && (
          <ol className="mx-auto mt-3 max-w-[220px] text-[12px]">
            {entries.slice(0, 3).map((e, i) => (
              <li key={`${e.date}-${i}`} className="flex justify-between">
                <span className="opacity-60">{i + 1}</span>
                <span>{e.initials}</span>
                <span className={ACCENT}>{e.score}</span>
              </li>
            ))}
          </ol>
        )}
        {!touch && <div className="mt-3 text-[10px] text-[#f5ead9]/50">space pause · r restart · m sound</div>}
      </div>
    </div>
  );
}

function GameOverPanel({ view, phase, entries, rank, touch, lastInitials, onSubmitInitials }: Props) {
  const cause = view.deathCause === 'self' ? 'bit your own tail' : 'hit the rocks';
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
            <InitialsEntry initial={lastInitials} onSubmit={onSubmitInitials} />
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

function Table({ entries, rank }: { entries: LeaderboardEntry[]; rank: number }) {
  if (entries.length === 0) return <div className="mt-4 text-center text-[11px] text-[#f5ead9]/60">no scores yet</div>;
  return (
    <ol className="mt-4 text-[12px]">
      {entries.map((e, i) => (
        <li
          key={`${e.date}-${i}`}
          className={`flex justify-between px-2 py-0.5 ${i === rank ? 'bg-[#ffb84d] font-bold text-[#1a1208]' : ''}`}
        >
          <span className="w-6 opacity-60">{i + 1}</span>
          <span className="flex-1">{e.initials}</span>
          <span className="w-16 text-right opacity-70">{e.length.toFixed(1)}</span>
          <span className="w-12 text-right">{e.score}</span>
        </li>
      ))}
    </ol>
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
