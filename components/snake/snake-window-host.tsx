'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { onSnakeClose, onSnakeOpen, onSnakeRaise } from '@/lib/snake-bus';
import { SnakeCanvas } from './snake-canvas';
import { SnakeWindow } from './snake-window';

export function SnakeWindowHost() {
  const [open, setOpen] = useState(false);
  const [raiseToken, setRaiseToken] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  // On /snake the full-page game is already running; a second one would fight it for the keyboard.
  const onSnakePage = pathname?.startsWith('/snake') ?? false;

  useEffect(() => {
    const offOpen = onSnakeOpen(() => {
      if (window.location.pathname.startsWith('/snake')) return;
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

  if (!open || onSnakePage) return null;
  return (
    <SnakeWindow
      key={raiseToken}
      onExpand={() => {
        setOpen(false);
        router.push('/snake');
      }}
    >
      <div className="relative min-h-0 flex-1">
        <SnakeCanvas variant="window" />
      </div>
    </SnakeWindow>
  );
}
