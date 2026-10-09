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
    const q = new URLSearchParams(window.location.search);
    // Shot mode hides the chrome, unless the HUD is asked for (?hud=1, the shot tool's --hud).
    setShot(q.has('shot') && !q.has('hud'));
    const onLock = () => setLocked(!!document.pointerLockElement);
    document.addEventListener('pointerlockchange', onLock);
    return () => document.removeEventListener('pointerlockchange', onLock);
  }, []);

  return (
    // Full-bleed above the site chrome: the planet owns the whole viewport.
    <div className="fixed inset-0 z-[80]" style={{ background: '#070B1A' }}>
      {/* First in the DOM, so it is first in the tab order too (the HUD and its world labels follow). */}
      {!shot && !locked && (
        <Link
          href="/"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !cameFromSite()) return;
            e.preventDefault();
            router.back();
          }}
          className="lb-back absolute z-10"
        >
          <span aria-hidden>←</span> back to site
        </Link>
      )}
      <LittlebigCanvas variant="page" />
      {/* The back link in the game's POP style (the HUD's look, components/littlebig/ui/styles.ts).
          Its own rule: it shows before the game's chunk arrives. The radius beats the site's global
          square corners by specificity. */}
      <style>{`
        .lb-back{top:calc(12px + env(safe-area-inset-top,0px));left:calc(12px + env(safe-area-inset-left,0px));display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 15px 1px 12px;font-family:ui-rounded,'SF Pro Rounded','Arial Rounded MT Bold','Nunito','Trebuchet MS',system-ui,sans-serif;font-size:13px;font-weight:800;letter-spacing:.01em;
          color:#1B1530;background:#FFF8E8;border:2px solid #1B1530;box-shadow:3px 3px 0 #1B1530;transition:transform .16s cubic-bezier(.3,1.65,.5,1),box-shadow .16s}
        a.lb-back{border-radius:99px !important}
        .lb-back span{font-weight:900;font-size:14px}
        .lb-back:hover{transform:translateY(-1.5px);box-shadow:3px 4.5px 0 #1B1530}
        .lb-back:active{transform:translateY(2px);box-shadow:1px 1px 0 #1B1530}
        .lb-back:focus-visible{outline:3px solid #FFB84D;outline-offset:2px}
        @media (pointer:coarse){.lb-back{height:44px}}
        @media (prefers-reduced-motion:reduce){.lb-back{transition:none}}
      `}</style>
    </div>
  );
}
