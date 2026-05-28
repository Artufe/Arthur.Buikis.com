'use client';

import { openIde } from '@/lib/ide-bus';

export function OpenInZedButton() {
  return (
    <button
      type="button"
      onClick={() => openIde()}
      className="open-in-zed"
      aria-label="Open this page in Zed (preview + source)"
    >
      <span className="open-in-zed__sheen" aria-hidden />
      <span className="open-in-zed__icon" aria-hidden>{'</>'}</span>
      <span className="open-in-zed__label">open in zed</span>
      <span className="open-in-zed__arrow" aria-hidden>↗</span>
    </button>
  );
}
