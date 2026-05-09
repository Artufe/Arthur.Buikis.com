'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { closeSnake } from '@/lib/snake-bus';

const POS_KEY = 'snake.window.pos';
const WIN_W = 560;
const WIN_H = 640;

type Pos = { x: number; y: number };

function readPos(): Pos | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
  } catch {}
  return null;
}

function writePos(p: Pos) {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {}
}

function clamp(p: Pos, w: number, h: number): Pos {
  const maxX = Math.max(0, window.innerWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  return { x: Math.min(maxX, Math.max(0, p.x)), y: Math.min(maxY, Math.max(0, p.y)) };
}

function defaultPos(w: number, h: number): Pos {
  return clamp({ x: (window.innerWidth - w) / 2, y: (window.innerHeight - h) / 2 }, w, h);
}

export function SnakeWindow({
  onExpand,
  children,
}: {
  onExpand: () => void;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<Pos>(() =>
    typeof window === 'undefined' ? { x: 0, y: 0 } : readPos() ?? defaultPos(WIN_W, WIN_H),
  );
  const [isMobile, setIsMobile] = useState(false);
  const dragRef = useRef<{ originX: number; originY: number; startX: number; startY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p, WIN_W, WIN_H));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isMobile) return;
      if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { originX: e.clientX, originY: e.clientY, startX: pos.x, startY: pos.y };
      setDragging(true);
    },
    [isMobile, pos],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = clamp(
      { x: d.startX + (e.clientX - d.originX), y: d.startY + (e.clientY - d.originY) },
      WIN_W,
      WIN_H,
    );
    setPos(next);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setDragging(false);
    setPos((p) => {
      writePos(p);
      return p;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSnake();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const baseStyle: React.CSSProperties = isMobile
    ? { position: 'fixed', inset: 0, zIndex: 90 }
    : {
        position: 'fixed',
        top: 0,
        left: 0,
        width: WIN_W,
        height: WIN_H,
        transform: `translate(${pos.x}px, ${pos.y}px)`,
        zIndex: 90,
      };

  return (
    <div
      style={baseStyle}
      className="bg-[var(--bg-muted)] border border-[var(--rule)] shadow-[0_40px_80px_rgba(0,0,0,0.7)] flex flex-col font-mono"
      role="dialog"
      aria-label="snake.py"
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`flex items-center justify-between px-4 py-2 border-b border-[var(--rule)] select-none ${
          isMobile ? '' : dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
      >
        <span className="text-[12px] text-[var(--fg)]/80">&gt; snake.py</span>
        <div className="flex items-center gap-1" data-no-drag>
          <button
            type="button"
            onClick={onExpand}
            aria-label="open in full page"
            className="px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:text-[var(--accent)]"
          >
            ↗
          </button>
          <button
            type="button"
            onClick={closeSnake}
            aria-label="close"
            className="px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:text-[var(--accent)]"
          >
            ×
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}
