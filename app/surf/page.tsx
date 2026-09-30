'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const GoldenlineCanvas = dynamic(
  () => import('@/components/goldenline/goldenline-canvas').then((m) => ({ default: m.GoldenlineCanvas })),
  { ssr: false },
);

export default function SurfPage() {
  const [locked, setLocked] = useState(false);
  const [shot, setShot] = useState(true);

  useEffect(() => {
    setShot(new URLSearchParams(window.location.search).has('shot'));
    const onLock = () => setLocked(!!document.pointerLockElement);
    document.addEventListener('pointerlockchange', onLock);
    return () => document.removeEventListener('pointerlockchange', onLock);
  }, []);

  return (
    // Full-bleed above the site chrome: the demo owns the whole viewport.
    <div className="fixed inset-0 z-[80]" style={{ background: '#0d0a08' }}>
      <GoldenlineCanvas variant="page" />
      {!shot && !locked && (
        <Link
          href="/"
          className="absolute top-3 left-4 z-10 font-mono text-[11px] tracking-[0.2em]"
          style={{ color: 'rgba(243,228,204,0.6)' }}
        >
          ← back to site
        </Link>
      )}
    </div>
  );
}
