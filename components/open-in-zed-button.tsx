'use client';

import { openIde } from '@/lib/ide-bus';

export function OpenInZedButton() {
  return (
    <button
      type="button"
      onClick={() => openIde()}
      className="ide-cta ide-cta--enter"
      aria-label="Open this page in Zed (preview + source)"
    >
      <span className="ide-cta__dot" aria-hidden />
      <span className="ide-cta__icon" aria-hidden>{'</>'}</span>
      <span className="ide-cta__label">open in zed</span>
    </button>
  );
}
