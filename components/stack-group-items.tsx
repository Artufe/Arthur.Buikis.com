'use client';

import { useState } from 'react';

const VISIBLE_LIMIT = 6;

export function StackGroupItems({ items }: { items: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const overflow = items.length > VISIBLE_LIMIT;
  const visible = !overflow || expanded ? items : items.slice(0, VISIBLE_LIMIT);
  const hiddenCount = items.length - VISIBLE_LIMIT;

  return (
    <>
      {visible.map((item) => (
        <span key={item} className="stack-item">
          {item}
        </span>
      ))}
      {overflow && !expanded && (
        <button
          type="button"
          className="stack-more"
          onClick={() => setExpanded(true)}
          aria-label={`Show ${hiddenCount} more items`}
        >
          (+{hiddenCount} more)
        </button>
      )}
    </>
  );
}
