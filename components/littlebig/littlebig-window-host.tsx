'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { FloatingWindow } from '@/components/floating-window';
import { closePlanet, onPlanetClose, onPlanetOpen, onPlanetRaise } from '@/lib/planet-bus';

// Nothing of LITTLEBIG loads until someone opens the window (or shows intent, below).
const LittlebigCanvas = dynamic(() => import('./littlebig-canvas').then((m) => ({ default: m.LittlebigCanvas })), {
  ssr: false,
});

/** Warm the LITTLEBIG chunks (JS only; the world is generated on open). Safe to call repeatedly. */
export function prefetchLittlebig() {
  void import('./littlebig-canvas');
  void import('./core/engine');
}

export function LittlebigWindowHost() {
  const [open, setOpen] = useState(false);
  const [raiseToken, setRaiseToken] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const onPlanetPage = pathname?.startsWith('/planet') ?? false;

  // Prefetch on the command palette's keys, so "visit planet" doesn't wait on the download.
  useEffect(() => {
    let done = false;
    const onKey = (e: KeyboardEvent) => {
      if (done) return;
      if (e.key !== '/' && !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return;
      done = true;
      window.removeEventListener('keydown', onKey);
      prefetchLittlebig();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const offOpen = onPlanetOpen(() => {
      if (window.location.pathname.startsWith('/planet')) return;
      setOpen((wasOpen) => {
        if (wasOpen) setRaiseToken((t) => t + 1);
        return true;
      });
    });
    const offClose = onPlanetClose(() => setOpen(false));
    const offRaise = onPlanetRaise(() => setRaiseToken((t) => t + 1));
    return () => {
      offOpen();
      offClose();
      offRaise();
    };
  }, []);

  if (!open || onPlanetPage) return null;
  return (
    <FloatingWindow
      key={raiseToken}
      title="littlebig"
      posKey="littlebig.window.pos"
      width={960}
      height={600}
      onClose={closePlanet}
      onExpand={() => {
        setOpen(false);
        router.push('/planet');
      }}
    >
      <div className="relative min-h-0 flex-1">
        <LittlebigCanvas variant="window" />
      </div>
    </FloatingWindow>
  );
}
