'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** Full-page games own navigation and focus; covered site chrome must not remain tabbable. */
export function SiteChrome({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (path === '/planet' || path?.startsWith('/planet/') || path === '/surf' || path?.startsWith('/surf/')) return null;
  return children;
}
