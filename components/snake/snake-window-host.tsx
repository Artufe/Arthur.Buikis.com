'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onSnakeClose, onSnakeOpen, onSnakeRaise } from '@/lib/snake-bus';
import { SnakeWindow } from './snake-window';

export function SnakeWindowHost() {
  const [open, setOpen] = useState(false);
  const [raiseToken, setRaiseToken] = useState(0);
  const router = useRouter();

  useEffect(() => {
    const offOpen = onSnakeOpen(() => {
      setOpen((wasOpen) => {
        if (wasOpen) setRaiseToken((t) => t + 1);
        return true;
      });
    });
    const offClose = onSnakeClose(() => setOpen(false));
    const offRaise = onSnakeRaise(() => setRaiseToken((t) => t + 1));
    return () => {
      offOpen();
      offClose();
      offRaise();
    };
  }, []);

  if (!open) return null;
  return (
    <SnakeWindow
      key={raiseToken}
      onExpand={() => {
        setOpen(false);
        router.push('/snake');
      }}
    >
      <div className="flex-1 flex items-center justify-center text-[11px] text-[var(--fg-faint)]">
        snake placeholder
      </div>
    </SnakeWindow>
  );
}
