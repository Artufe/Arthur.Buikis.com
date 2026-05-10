import type { ReactNode } from 'react';
import Image from 'next/image';

export function Figure({
  src,
  alt,
  caption,
  width = 1200,
  height = 800,
}: {
  src: string;
  alt: string;
  caption?: ReactNode;
  width?: number;
  height?: number;
}) {
  return (
    <figure className="my-10 group">
      <div className="overflow-hidden border-2 border-[var(--border)]">
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          className="w-full h-auto"
        />
      </div>
      {caption && (
        <figcaption className="mt-3 font-body text-sm text-[var(--muted)]">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
