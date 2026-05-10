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
  const prevTailRef = useRef<Cell | null>(null);
  const [mounted, setMounted] = useState(false);
  const [status, setStatus] = useState<GameState['status']>('idle');
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [comboCount, setComboCount] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [maxLength, setMaxLength] = useState(0);

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
      prevTailRef.current = initial.snake[initial.snake.length - 1];
      onConsoleChange?.(initial.consoleLines);
      setStatus(initial.status);
      setScore(initial.score);
      setBest(initial.best);
      setComboCount(initial.comboCount);
      setBestCombo(initial.bestCombo);
      setMaxLength(initial.maxLength);
      setMounted(true);

      let lastFrame = now;
      let acc = 0;
      const loop = () => {
        if (!stateRef.current || !handleRef.current) return;
        const t = performance.now();
        const dt = t - lastFrame;
        lastFrame = t;
        // Only advance the accumulator while playing. Otherwise gameover/paused time would
        // pile up and on resume the step loop would fire many ticks at once — restart used
        // to teleport the snake straight into a wall.
        if (stateRef.current.status === 'playing') acc += dt;
        else acc = 0;
        const tickInterval = 1000 / stateRef.current.tickRate;
        while (acc >= tickInterval && stateRef.current.status === 'playing') {
          const before = stateRef.current;
          const after = step(before, before.lastTickAt + tickInterval);
          const ate = after.score !== before.score || after.snake.length !== before.snake.length;
          // The eaten pellet is the one whose cell matches the new head's destination.
          const newHead = after.snake[0];
          const eaten = ate ? before.pellets.find((p) => p.cell.x === newHead.x && p.cell.y === newHead.y) : null;
          if (ate && eaten) {
            // Light shake on every eat — universal "thump" feedback.
            // Heavier on claude (the rare big-payoff pellet).
            const intensity = eaten.kind === 'claude' ? 6 : 3;
            handleRef.current.triggerShake(intensity, 180);
            if (eaten.kind === 'claude') handleRef.current.triggerShockwave(eaten.cell);
            if (eaten.kind === 'async') handleRef.current.flashGlitch();
          }
          if (after.status === 'gameover' && before.status === 'playing') {
            handleRef.current.flashGlitch();
            handleRef.current.triggerShake(12, 400);
            handleRef.current.triggerDeathCascade(before.snake);
            if (after.score > readBest()) writeBest(after.score);
          }
          if (after.consoleLines !== before.consoleLines) {
            onConsoleChange?.(after.consoleLines);
          }
          if (after.status !== before.status) setStatus(after.status);
          if (after.score !== before.score) setScore(after.score);
          if (after.best !== before.best) setBest(after.best);
          if (after.comboCount !== before.comboCount) setComboCount(after.comboCount);
          if (after.bestCombo !== before.bestCombo) setBestCombo(after.bestCombo);
          if (after.maxLength !== before.maxLength) setMaxLength(after.maxLength);
          // Save the pre-tick tail so we can lerp from it during the next frame.
          // On growth ticks the tail didn't move, so prevTail equals the new tail's cell anyway.
          prevTailRef.current = before.snake[before.snake.length - 1];
          stateRef.current = after;
          acc -= tickInterval;
        }
        // Head + tail tweens for fluid motion at both ends of the snake.
        const s = stateRef.current;
        const head = s.snake[0];
        const tail = s.snake[s.snake.length - 1];
        let headTween: Cell;
        let tailTween: Cell;
        if (reducedMotionRef.current) {
          headTween = head;
          tailTween = tail;
        } else {
          const tickInterval2 = 1000 / s.tickRate;
          const tweenT = Math.min(1, acc / tickInterval2);
          const headPrev = s.snake[1] ?? head;
          headTween = {
            x: headPrev.x + (head.x - headPrev.x) * tweenT,
            y: headPrev.y + (head.y - headPrev.y) * tweenT,
          };
          const tailPrev = prevTailRef.current ?? tail;
          tailTween = {
            x: tailPrev.x + (tail.x - tailPrev.x) * tweenT,
            y: tailPrev.y + (tail.y - tailPrev.y) * tweenT,
          };
        }
        handleRef.current.render(s, headTween, tailTween, t);
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
        const next = applyInput(s, { type: 'pause' });
        stateRef.current = next;
        setStatus(next.status);
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        const next = applyInput({ ...s, best: readBest() }, { type: 'restart' });
        stateRef.current = next;
        prevTailRef.current = next.snake[next.snake.length - 1];
        setStatus(next.status);
        setScore(next.score);
        setBest(next.best);
        setComboCount(next.comboCount);
        setBestCombo(next.bestCombo);
        setMaxLength(next.maxLength);
        onConsoleChange?.(next.consoleLines);
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

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      reducedMotionRef.current = mq.matches;
      handleRef.current?.setReducedMotion(mq.matches);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
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
    <div
      style={{
        position: 'relative',
        // Subtle accent-toned frame so the play-area edges read clearly against
        // the surrounding background. 1px hard line + a soft outer glow ties it
        // to the rest of the terminal/CRT vibe without re-adding the shader.
        border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.6), 0 0 18px color-mix(in srgb, var(--accent) 12%, transparent)',
      }}
    >
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
      {/* Corner brackets — terminal-style "this is your bounded play area" markers.
          Quick visual confirmation of the four corners on top of the soft frame. */}
      {(['top-1 left-1 border-t border-l', 'top-1 right-1 border-t border-r', 'bottom-1 left-1 border-b border-l', 'bottom-1 right-1 border-b border-r'] as const).map(
        (pos, i) => (
          <span
            key={i}
            aria-hidden
            className={`absolute ${pos} w-3 h-3 border-[var(--accent)]/70 pointer-events-none`}
          />
        ),
      )}
      <div className="absolute top-2 left-2 font-mono text-[11px] text-[var(--accent)] pointer-events-none select-none">
        score {score}
      </div>
      <div className="absolute top-2 right-2 font-mono text-[11px] text-[var(--fg-muted)] pointer-events-none select-none">
        best {best}
      </div>
      {/* Combo badge — visible only while a streak is active. Bottom-left so it doesn't
          compete with score (top-left) and pulses to signal momentum. */}
      {comboCount >= 2 && status === 'playing' && (
        <div className="absolute bottom-2 left-2 font-mono text-[14px] font-bold text-[var(--accent)] pointer-events-none select-none animate-pulse tracking-wider">
          ×{comboCount} combo
        </div>
      )}
      {status === 'paused' && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center font-mono text-[13px] text-[var(--accent)] pointer-events-none">
          // paused
        </div>
      )}
      {status === 'gameover' && (
        <div className="absolute inset-0 bg-black/65 flex flex-col items-center justify-center gap-2 font-mono pointer-events-none px-4 text-center">
          <div className="text-[14px] text-[#ff7070] font-bold">
            panic! at line {score}
          </div>
          <div className="text-[10px] text-[var(--fg-faint)] flex gap-3 mt-1">
            <span>len <span className="text-[var(--fg-muted)]">{maxLength}</span></span>
            <span>combo <span className="text-[var(--fg-muted)]">×{bestCombo}</span></span>
            <span>best <span className="text-[var(--fg-muted)]">{best}</span></span>
          </div>
          <div className="text-[11px] text-[var(--accent)] mt-2">press r to restart</div>
        </div>
      )}
    </div>
  );
}
