'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const Palette = dynamic(
  () => import('./command-palette').then((m) => ({ default: m.CommandPalette })),
  { ssr: false }
);

type IdleHandle = number | NodeJS.Timeout;
type RICWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function CommandPaletteLazy() {
  // The query to open with, or null until something first asks for the palette.
  // The palette mounts ~300ms after that (chunk import plus React's Suspense
  // reveal throttle, even when prefetched), too late to hear a palette:open
  // event, so the request goes in as props and it opens itself on mount.
  const [request, setRequest] = useState<string | null>(null);

  useEffect(() => {
    if (request !== null) return;

    const trigger = (initialQuery = '') => setRequest(initialQuery);

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (editable) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        trigger();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        trigger();
      }
    };

    const onCustomOpen = (e: Event) =>
      trigger((e as CustomEvent<{ initialQuery?: string }>).detail?.initialQuery ?? '');

    window.addEventListener('keydown', onKey);
    window.addEventListener('palette:open', onCustomOpen);

    // Idle-prefetch the palette so first-trigger has nothing to wait for.
    const w = window as RICWindow;
    let idleHandle: IdleHandle | null = null;
    if (typeof w.requestIdleCallback === 'function') {
      idleHandle = w.requestIdleCallback(
        () => {
          import('./command-palette');
        },
        { timeout: 4000 }
      );
    } else {
      idleHandle = setTimeout(() => {
        import('./command-palette');
      }, 2500);
    }

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('palette:open', onCustomOpen);
      if (idleHandle !== null) {
        if (typeof w.cancelIdleCallback === 'function' && typeof idleHandle === 'number') {
          w.cancelIdleCallback(idleHandle);
        } else {
          clearTimeout(idleHandle as NodeJS.Timeout);
        }
      }
    };
  }, [request]);

  if (request === null) return null;
  return <Palette openOnMount initialQuery={request} />;
}
