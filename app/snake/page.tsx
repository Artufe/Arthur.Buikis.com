'use client';

import dynamic from 'next/dynamic';

const SnakeCanvas = dynamic(
  () => import('@/components/snake/snake-canvas').then((m) => ({ default: m.SnakeCanvas })),
  { ssr: false },
);

export default function SnakePage() {
  return (
    // The sticky nav (66px) is in flow, so cancel main's pt-16 and fill the rest of the viewport.
    <div className="relative -mt-16 h-[calc(100svh-66px)] min-h-[420px] w-full">
      <SnakeCanvas variant="page" />
    </div>
  );
}
