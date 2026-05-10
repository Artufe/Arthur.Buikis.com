'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { openPalette } from '@/lib/palette-bus';

const PHRASES = [
  'backend · platform · rust',
  'python + some rust',
  'self-taught · riga',
  'observability > tests',
  'boring tech. intentionally.',
];

const TYPING_SPEED = 60;
const DELETING_SPEED = 20;
const PAUSE = 2000;

export function TypewriterBar() {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'typing' | 'pausing' | 'deleting'>('typing');
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [mounted, setMounted] = useState(false);
  const reduced = useRef(false);

  useEffect(() => {
    setMounted(true);
    if (typeof window !== 'undefined') {
      reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
  }, []);

  useEffect(() => {
    if (!mounted || reduced.current) {
      setText(PHRASES[0]);
      return;
    }

    const phrase = PHRASES[phraseIdx];
    const timer = setTimeout(() => {
      if (phase === 'typing') {
        const next = charIdx + 1;
        setText(phrase.slice(0, next));
        if (next >= phrase.length) {
          setPhase('pausing');
        } else {
          setCharIdx(next);
        }
      } else if (phase === 'pausing') {
        setPhase('deleting');
      } else if (phase === 'deleting') {
        const next = charIdx - 1;
        setText(phrase.slice(0, next));
        if (next <= 0) {
          setPhase('typing');
          setCharIdx(0);
          setPhraseIdx((i) => (i + 1) % PHRASES.length);
        } else {
          setCharIdx(next);
        }
      }
    }, phase === 'pausing' ? PAUSE : phase === 'deleting' ? DELETING_SPEED : TYPING_SPEED);

    return () => clearTimeout(timer);
  }, [mounted, phraseIdx, charIdx, phase]);

  const handleClick = useCallback(() => {
    openPalette();
  }, []);

  return (
    <div
      className="cmd-bar"
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter') handleClick(); }}
      role="button"
      tabIndex={0}
    >
      <span className="prompt">$</span>
      <span className="typed-text">
        {text}
        <span className="typed-cursor" aria-hidden="true">▎</span>
      </span>
      <span className="hint">ctrl+k · /</span>
    </div>
  );
}
