'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  commandGroups,
  commands,
  helpLines,
  whoamiLines,
  type Command,
  type CommandGroup,
} from '@/lib/commands';
import { fuzzyMatch, type FuzzyMatch } from '@/lib/fuzzy';
import { onPaletteClose, onPaletteOpen } from '@/lib/palette-bus';

type Inline =
  | { kind: 'whoami' }
  | { kind: 'help' }
  | { kind: 'copied'; value: string }
  | null;

type Scored = { cmd: Command; match: FuzzyMatch };

function scoreCommands(query: string): Scored[] {
  if (!query.trim()) return commands.map((cmd) => ({ cmd, match: { score: 0, indices: [] } }));
  const q = query.trim();
  const results: Scored[] = [];
  for (const cmd of commands) {
    const labelMatch = fuzzyMatch(q, cmd.label);
    const keywordMatch = cmd.keywords
      ? cmd.keywords.map((k) => fuzzyMatch(q, k)).find((m): m is FuzzyMatch => m !== null) ?? null
      : null;
    const match = labelMatch ?? keywordMatch;
    if (match) results.push({ cmd, match });
  }
  results.sort((a, b) => b.match.score - a.match.score);
  return results;
}

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const set = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) => (
        <span key={i} className={set.has(i) ? 'text-[var(--accent)]' : undefined}>
          {ch}
        </span>
      ))}
    </>
  );
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [inline, setInline] = useState<Inline>(null);
  const [hintVisible, setHintVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();

  const results = useMemo(() => scoreCommands(query), [query]);

  const flatResults = results;

  const grouped = useMemo(() => {
    const map = new Map<CommandGroup, Scored[]>();
    for (const r of flatResults) {
      const arr = map.get(r.cmd.group) ?? [];
      arr.push(r);
      map.set(r.cmd.group, arr);
    }
    return commandGroups
      .map((g) => ({ group: g, items: map.get(g) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [flatResults]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSelectedIdx(0);
    setInline(null);
  }, []);

  const runAction = useCallback(
    (cmd: Command) => {
      switch (cmd.action.type) {
        case 'navigate':
          router.push(cmd.action.href);
          close();
          break;
        case 'external':
          window.open(cmd.action.href, '_blank', 'noopener,noreferrer');
          close();
          break;
        case 'download': {
          const a = document.createElement('a');
          a.href = cmd.action.href;
          if (cmd.action.filename) a.download = cmd.action.filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          close();
          break;
        }
        case 'theme':
          setTheme(cmd.action.value);
          close();
          break;
        case 'copy':
          navigator.clipboard.writeText(cmd.action.value).catch(() => {});
          setInline({ kind: 'copied', value: cmd.action.value });
          break;
        case 'whoami':
          setInline({ kind: 'whoami' });
          break;
        case 'help':
          setInline({ kind: 'help' });
          break;
      }
    },
    [router, setTheme, close]
  );

  useEffect(() => {
    const unsubOpen = onPaletteOpen((initial) => {
      setOpen(true);
      setQuery(initial);
      setInline(null);
      setSelectedIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    const unsubClose = onPaletteClose(close);
    return () => {
      unsubOpen();
      unsubClose();
    };
  }, [close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open) {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIdx((i) => Math.min(i + 1, Math.max(flatResults.length - 1, 0)));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const item = flatResults[selectedIdx];
          if (item) runAction(item.cmd);
          return;
        }
        return;
      }

      const target = e.target as HTMLElement | null;
      const isEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          (target as HTMLElement).isContentEditable);
      if (isEditable) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
        setInline(null);
        setSelectedIdx(0);
        requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        setOpen(true);
        setInline(null);
        setSelectedIdx(0);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, flatResults, selectedIdx, runAction, close]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 768px)');
    if (!mq.matches) return;
    let triggered = false;
    const show = () => {
      if (triggered) return;
      triggered = true;
      setTimeout(() => setHintVisible(true), 2000);
      window.removeEventListener('scroll', show);
    };
    window.addEventListener('scroll', show, { passive: true });
    const fallback = setTimeout(show, 6000);
    return () => {
      window.removeEventListener('scroll', show);
      clearTimeout(fallback);
    };
  }, []);

  let runningIndex = 0;

  return (
    <>
      {hintVisible && !open && (
        <div className="fixed bottom-5 right-5 hidden md:flex items-center gap-2 font-mono text-[10px] text-[var(--fg-faint)] pointer-events-none z-40">
          <span>press</span>
          <span className="kbd">/</span>
          <span>for commands</span>
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[1px] flex items-start justify-center pt-[14vh] px-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="w-full max-w-[540px] bg-[var(--bg)] border border-[var(--rule-strong)] shadow-[0_30px_60px_rgba(0,0,0,0.7)] font-mono">
            <div className="flex items-center gap-2 px-4.5 py-3.5 border-b border-[var(--rule)] px-5">
              <span className="text-[var(--accent)] text-[15px]">›</span>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="type a command…"
                aria-label="Command palette"
                className="flex-1 bg-transparent border-none outline-none font-mono text-[14px] text-[var(--fg)] placeholder:text-[var(--fg-faint)]"
              />
              <span className="text-[10px] text-[var(--fg-faint)]">
                {inline?.kind === 'whoami'
                  ? 'ran'
                  : inline?.kind === 'help'
                    ? 'ran'
                    : inline?.kind === 'copied'
                      ? 'copied'
                      : query
                        ? `${flatResults.length} result${flatResults.length === 1 ? '' : 's'}`
                        : 'esc'}
              </span>
            </div>

            {inline?.kind === 'whoami' && (
              <div className="px-5 py-3.5 bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] border-b border-[var(--rule)] text-[13px] leading-[1.75] text-[var(--fg)]/90">
                <div className="text-[var(--fg-muted)]">{whoamiLines.prompt}</div>
                {whoamiLines.lines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
                <div className="mt-2 text-[var(--fg-faint)]">
                  — try also:{' '}
                  {whoamiLines.hintSuggestions.map((tok, i, arr) => (
                    <span key={tok}>
                      <span className="text-[var(--accent)]">{tok}</span>
                      {i < arr.length - 1 ? ', ' : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {inline?.kind === 'help' && (
              <div className="px-5 py-3.5 bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] border-b border-[var(--rule)] text-[13px] leading-[1.8] text-[var(--fg)]/90">
                <div className="text-[var(--fg-muted)]">{helpLines.prompt}</div>
                {helpLines.lines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
                <div className="mt-2 text-[var(--fg-faint)]">— {helpLines.hint}</div>
              </div>
            )}

            {inline?.kind === 'copied' && (
              <div className="px-5 py-3.5 bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] border-b border-[var(--rule)] text-[13px] text-[var(--fg)]/90">
                copied to clipboard · <span className="text-[var(--accent)]">{inline.value}</span>
              </div>
            )}

            {!inline && grouped.length > 0 && (
              <div className="max-h-[50vh] overflow-y-auto py-1.5">
                {grouped.map(({ group, items }) => (
                  <div key={group} className="py-1">
                    <div className="px-5 py-1 text-[8px] font-sans uppercase tracking-[0.24em] text-[var(--fg-faint)]">
                      {group}
                    </div>
                    {items.map(({ cmd, match }) => {
                      const idx = runningIndex++;
                      const isSelected = idx === selectedIdx;
                      const isCurrentTheme =
                        cmd.action.type === 'theme' &&
                        ((cmd.action.value === 'dark' && resolvedTheme === 'dark') ||
                          (cmd.action.value === 'light' && resolvedTheme === 'light'));
                      return (
                        <button
                          key={cmd.id}
                          type="button"
                          onMouseEnter={() => setSelectedIdx(idx)}
                          onClick={() => runAction(cmd)}
                          className={`w-full flex items-center gap-3 text-[12.5px] text-left transition-colors duration-[var(--dur-fast)] ${
                            isSelected
                              ? 'pl-4 pr-5 py-1.5 bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)] border-l-2 border-[var(--accent)]'
                              : 'px-5 py-1.5 text-[var(--fg)]/85 border-l-2 border-transparent'
                          }`}
                        >
                          <span
                            className={
                              isSelected ? 'text-[var(--accent)]' : 'text-[var(--fg-faint)]'
                            }
                          >
                            {cmd.arrow}
                          </span>
                          <span className="flex-1">
                            <Highlight text={cmd.label} indices={match.indices} />
                          </span>
                          <span
                            className={`text-[10px] ${
                              isSelected ? 'text-[var(--accent)]' : 'text-[var(--fg-faint)]'
                            }`}
                          >
                            {isCurrentTheme ? 'current' : cmd.hint ?? ''}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}

            {!inline && grouped.length === 0 && (
              <div className="px-5 py-8 text-center text-[12px] text-[var(--fg-faint)]">
                no matches. try{' '}
                <span className="text-[var(--accent)]">help</span> or{' '}
                <span className="text-[var(--accent)]">whoami</span>.
              </div>
            )}

            <div className="flex items-center justify-between px-5 py-2 border-t border-[var(--rule)] text-[10px] text-[var(--fg-faint)]">
              <div className="flex gap-3">
                {inline ? (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="kbd">esc</span>close
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="kbd">↵</span>run again
                    </span>
                  </>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="kbd">↑↓</span>move
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="kbd">↵</span>run
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="kbd">esc</span>close
                    </span>
                  </>
                )}
              </div>
              <span>
                {inline?.kind === 'whoami' || inline?.kind === 'help'
                  ? 'easter egg'
                  : query
                    ? `fuzzy · ${flatResults.length} of ${commands.length}`
                    : 'v1'}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
