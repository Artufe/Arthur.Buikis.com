'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onSnakeClose, onSnakeOpen, onSnakeRaise } from '@/lib/snake-bus';
import { SnakeWindow } from './snake-window';
import { SnakeCanvas } from './snake-canvas';
import { SnakeConsole } from './snake-console';
import type { ConsoleLine } from './snake-types';

export function SnakeWindowHost() {
  const [open, setOpen] = useState(false);
  const [raiseToken, setRaiseToken] = useState(0);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
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
      <div className="flex-1 flex">
        <div className="flex-1 flex items-center justify-center bg-[#0a0a0a]">
          <SnakeCanvas variant="window" onConsoleChange={setLines} />
        </div>
        <SnakeConsole lines={lines} />
      </div>
    </SnakeWindow>
  );
}
