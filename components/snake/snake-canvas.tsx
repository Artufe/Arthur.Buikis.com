'use client';

import { useEffect, useRef, useState } from 'react';
import { applyInput, createInitialState, step } from './snake-engine';
import type { RendererHandle } from './snake-renderer';
import type { Cell, ConsoleLine, Direction, GameState } from './snake-types';

type Props = {
  variant: 'window' | 'page';
  onConsoleChange?: (lines: ConsoleLine[]) => void;
};

const BEST_KEY = 'snake.best';

const KEY_TO_DIR: Record<string, Direction | undefined> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  W: 'up',
  s: 'down',
  S: 'down',
  a: 'left',
  A: 'left',
  d: 'right',
  D: 'right',
};

function readBest(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const v = window.localStorage.getItem(BEST_KEY);
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeBest(n: number) {
  try {
    window.localStorage.setItem(BEST_KEY, String(n));
  } catch {}
}

function getCssColor(name: string, fallback: string): number {
  if (typeof window === 'undefined') return parseInt(fallback.slice(1), 16);
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const hex = v.startsWith('#') ? v.slice(1) : v;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : parseInt(fallback.slice(1), 16);
}

export function SnakeCanvas({ variant, onConsoleChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState | null>(null);
  const handleRef = useRef<RendererHandle | null>(null);
  const rafRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);
  const [mounted, setMounted] = useState(false);

  const gridCount = variant === 'page' ? 28 : 22;
  const cellSize = variant === 'page' ? 22 : 20;

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    (async () => {
      const { mount } = await import('./snake-renderer');
      if (cancelled || !canvasRef.current) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      reducedMotionRef.current = reduced;
      const accentHex = getCssColor('--accent', '#FFB84D');
      const handle = await mount(canvas, {
        gridCount,
        cellSize,
        reducedMotion: reduced,
        accentHex,
        panicHex: 0xff5050,
        bgHex: 0x0a0a0a,
      });
      if (cancelled) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;

      const now = performance.now();
      const initial = createInitialState({
        gridCount,
        seed: Math.floor(Math.random() * 0x7fffffff),
        now,
        best: readBest(),
      });
      stateRef.current = initial;
      onConsoleChange?.(initial.consoleLines);
      setMounted(true);

      let lastFrame = now;
      let acc = 0;
      const loop = () => {
        if (!stateRef.current || !handleRef.current) return;
        const t = performance.now();
        const dt = t - lastFrame;
        lastFrame = t;
        acc += dt;
        const tickInterval = 1000 / stateRef.current.tickRate;
        while (acc >= tickInterval && stateRef.current.status === 'playing') {
          const before = stateRef.current;
          const after = step(before, before.lastTickAt + tickInterval);
          const ate = after.score !== before.score || after.snake.length !== before.snake.length;
          if (ate && before.pellet.kind === 'claude') {
            handleRef.current.triggerShockwave(before.pellet.cell);
          }
          if (ate && before.pellet.kind === 'async') {
            handleRef.current.flashGlitch();
          }
          if (after.status === 'gameover' && before.status === 'playing') {
            handleRef.current.flashGlitch();
            if (after.score > readBest()) writeBest(after.score);
          }
          if (after.consoleLines !== before.consoleLines) {
            onConsoleChange?.(after.consoleLines);
          }
          stateRef.current = after;
          acc -= tickInterval;
        }
        // Head tween position
        const s = stateRef.current;
        const head = s.snake[0];
        let headTween: Cell;
        if (reducedMotionRef.current) {
          headTween = head;
        } else {
          const tickInterval2 = 1000 / s.tickRate;
          const tweenT = Math.min(1, acc / tickInterval2);
          const prev = s.snake[1] ?? head;
          headTween = {
            x: prev.x + (head.x - prev.x) * tweenT,
            y: prev.y + (head.y - prev.y) * tweenT,
          };
        }
        handleRef.current.render(s, headTween);
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    })();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      handleRef.current?.dispose();
      handleRef.current = null;
      stateRef.current = null;
    };
  }, [gridCount, cellSize, onConsoleChange]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const s = stateRef.current;
      if (!s) return;
      if (e.key === ' ') {
        e.preventDefault();
        stateRef.current = applyInput(s, { type: 'pause' });
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        stateRef.current = applyInput({ ...s, best: readBest() }, { type: 'restart' });
        return;
      }
      const dir = KEY_TO_DIR[e.key];
      if (dir) {
        e.preventDefault();
        stateRef.current = applyInput(s, { type: 'turn', dir });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Touch swipe (mobile)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let startX = 0;
    let startY = 0;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      startX = e.clientX;
      startY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
      const dir: Direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      const s = stateRef.current;
      if (s) stateRef.current = applyInput(s, { type: 'turn', dir });
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: gridCount * cellSize,
        height: gridCount * cellSize,
        display: 'block',
        touchAction: 'none',
      }}
      data-mounted={mounted ? '1' : '0'}
    />
  );
}
