'use client';

import { useEffect, useRef, useState } from 'react';
import { normalizeInitials } from './leaderboard';

const A = 'A'.charCodeAt(0);

function shift(letter: string, by: number): string {
  return String.fromCharCode(A + ((letter.charCodeAt(0) - A + by + 26) % 26));
}

export function InitialsEntry({ initial, onSubmit }: { initial: string; onSubmit: (initials: string) => void }) {
  const [letters, setLetters] = useState(() => (normalizeInitials(initial) + 'AAA').slice(0, 3).split(''));
  const [slot, setSlot] = useState(0);
  const lettersRef = useRef(letters);
  lettersRef.current = letters;
  const slotRef = useRef(slot);
  slotRef.current = slot;
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  useEffect(() => {
    // Capture phase on window runs before the game's own (bubble) key handler, so letters
    // like R (restart) or M (mute) typed here never reach it.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      const current = slotRef.current;
      if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        setLetters((l) => l.map((c, i) => (i === current ? e.key.toUpperCase() : c)));
        setSlot(Math.min(2, current + 1));
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setSlot(Math.max(0, current - 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSlot(Math.max(0, current - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSlot(Math.min(2, current + 1));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const by = e.key === 'ArrowUp' ? 1 : -1;
        setLetters((l) => l.map((c, i) => (i === current ? shift(c, by) : c)));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        submitRef.current(lettersRef.current.join(''));
      } else if (e.key !== 'Escape') {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const bump = (i: number, by: number) => {
    setSlot(i);
    setLetters((l) => l.map((c, j) => (j === i ? shift(c, by) : c)));
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="text-[11px] uppercase tracking-[0.2em] text-[#f5ead9]/70">new high score — your initials</div>
      <div className="flex gap-2">
        {letters.map((c, i) => (
          <div key={i} className="flex flex-col items-center">
            <button
              type="button"
              aria-label={`next letter for slot ${i + 1}`}
              onClick={() => bump(i, 1)}
              className="px-3 py-0.5 text-[12px] text-[#f5ead9]/70 hover:text-[#ffb84d]"
            >
              ▲
            </button>
            <button
              type="button"
              aria-label={`slot ${i + 1}: ${c}`}
              onClick={() => setSlot(i)}
              className={`w-11 h-12 text-[26px] font-bold border-2 ${
                i === slot ? 'border-[#ffb84d] text-[#ffb84d]' : 'border-white/20 text-[#f5ead9]'
              }`}
            >
              {c}
            </button>
            <button
              type="button"
              aria-label={`previous letter for slot ${i + 1}`}
              onClick={() => bump(i, -1)}
              className="px-3 py-0.5 text-[12px] text-[#f5ead9]/70 hover:text-[#ffb84d]"
            >
              ▼
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        aria-label="save initials"
        onClick={() => onSubmit(letters.join(''))}
        className="px-4 py-1.5 text-[12px] uppercase tracking-[0.2em] bg-[#ffb84d] text-[#1a1208] font-bold"
      >
        save
      </button>
      <div className="text-[10px] text-[#f5ead9]/55">type letters · enter to save</div>
    </div>
  );
}
