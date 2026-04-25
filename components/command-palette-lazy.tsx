'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { openPalette } from '@/lib/palette-bus';

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
  const [load, setLoad] = useState(false);

  useEffect(() => {
    if (load) return;

    const trigger = (initialQuery = '') => {
      setLoad(true);
      // Two animation frames — give the dynamic import time to resolve and
      // the Palette component time to mount its onPaletteOpen listener.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => openPalette(initialQuery));
      });
    };

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

    const onCustomOpen = () => trigger();

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
  }, [load]);

  if (!load) return null;
  return <Palette />;
}
