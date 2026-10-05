'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { loadLittlebigCanvas, prefetchLittlebig } from '@/components/littlebig/handoff';

// The same loader as the window host's and the prefetch (one chunk, see handoff.ts).
const LittlebigCanvas = dynamic(() => loadLittlebigCanvas().then((m) => ({ default: m.LittlebigCanvas })), {
  ssr: false,
  loading: () => <div className="absolute inset-0" style={{ background: '#070B1A' }} />,
});

// True when the previous history entry is a page of this site: either the document was first
// loaded at another URL (so /planet was reached by client navigation, e.g. from /play or the
// window's ↗), or it was loaded here from a same-origin link.
function cameFromSite(): boolean {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (nav && new URL(nav.name).pathname !== window.location.pathname) return true;
  try {
    return !!document.referrer && new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

export default function PlanetPage() {
  // Engine and three download alongside the canvas chunk (in render, not module scope: a route
  // prefetch of this page must not pull the game).
  if (typeof window !== 'undefined') prefetchLittlebig();
  const router = useRouter();
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
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !cameFromSite()) return;
            e.preventDefault();
            router.back();
          }}
          className="absolute top-3 left-4 z-10 font-mono text-[11px] tracking-[0.2em]"
          style={{ color: 'rgba(225,232,255,0.65)' }}
        >
          ← back to site
        </Link>
      )}
    </div>
  );
}
