'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { SnakeConsole } from '@/components/snake/snake-console';
import type { ConsoleLine } from '@/components/snake/snake-types';

const SnakeCanvas = dynamic(
  () => import('@/components/snake/snake-canvas').then((m) => ({ default: m.SnakeCanvas })),
  { ssr: false },
);

export default function SnakePage() {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  return (
    <div className="min-h-[80vh] flex items-center justify-center bg-[#0a0a0a]">
      <div className="flex">
        <div className="flex items-center justify-center">
          <SnakeCanvas variant="page" onConsoleChange={setLines} />
        </div>
        <SnakeConsole lines={lines} />
      </div>
    </div>
  );
}
