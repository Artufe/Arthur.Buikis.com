'use client';

import { openIde } from '@/lib/ide-bus';

export function IdeTrigger() {
  return (
    <button
      type="button"
      onClick={() => openIde()}
      className="footer-ide-link"
      title="Open in Zed"
      aria-label="Open this page in Zed (preview + source)"
    >
      $EDITOR ↗
    </button>
  );
}
