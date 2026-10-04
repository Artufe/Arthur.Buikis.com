'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const LittlebigCanvas = dynamic(
  () => import('@/components/littlebig/littlebig-canvas').then((m) => ({ default: m.LittlebigCanvas })),
  { ssr: false },
);

export default function PlanetPage() {
  const [locked, setLocked] = useState(false);
  const [shot, setShot] = useState(true);

  useEffect(() => {
    setShot(new URLSearchParams(window.location.search).has('shot'));
    const onLock = () => setLocked(!!document.pointerLockElement);
    document.addEventListener('pointerlockchange', onLock);
    return () => document.removeEventListener('pointerlockchange', onLock);
  }, []);

  return (
    // Full-bleed above the site chrome: the planet owns the whole viewport.
    <div className="fixed inset-0 z-[80]" style={{ background: '#070B1A' }}>
      <LittlebigCanvas variant="page" />
      {!shot && !locked && (
        <Link
          href="/"
          className="absolute top-3 left-4 z-10 font-mono text-[11px] tracking-[0.2em]"
          style={{ color: 'rgba(225,232,255,0.65)' }}
        >
          ← back to site
        </Link>
      )}
    </div>
  );
}
