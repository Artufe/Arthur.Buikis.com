'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { FloatingWindow } from '@/components/floating-window';
import { closeSurf, onSurfClose, onSurfOpen, onSurfRaise } from '@/lib/surf-bus';

// The engine is heavy; nothing of it loads until someone actually opens the window.
const GoldenlineCanvas = dynamic(() => import('./goldenline-canvas').then((m) => ({ default: m.GoldenlineCanvas })), {
  ssr: false,
});

export function GoldenlineWindowHost() {
  const [open, setOpen] = useState(false);
  const [raiseToken, setRaiseToken] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const onSurfPage = pathname?.startsWith('/surf') ?? false;

  useEffect(() => {
    const offOpen = onSurfOpen(() => {
      if (window.location.pathname.startsWith('/surf')) return;
      setOpen((wasOpen) => {
        if (wasOpen) setRaiseToken((t) => t + 1);
        return true;
      });
    });
    const offClose = onSurfClose(() => setOpen(false));
    const offRaise = onSurfRaise(() => setRaiseToken((t) => t + 1));
    return () => {
      offOpen();
      offClose();
      offRaise();
    };
  }, []);

  if (!open || onSurfPage) return null;
  return (
    <FloatingWindow
      key={raiseToken}
      title="goldenline"
      posKey="goldenline.window.pos"
      width={960}
      height={578}
      onClose={closeSurf}
      onExpand={() => {
        setOpen(false);
        router.push('/surf');
      }}
    >
      <div className="relative min-h-0 flex-1">
        <GoldenlineCanvas variant="window" />
      </div>
    </FloatingWindow>
  );
}
