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
      <div className="overflow-hidden shadow-[0_4px_20px_rgba(0,0,0,0.06)] transition-shadow duration-[var(--dur-base)] group-hover:shadow-[0_8px_32px_rgba(0,0,0,0.12)]">
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          className="w-full h-auto grayscale transition-[filter,transform] duration-[var(--dur-cinematic)] ease-[var(--ease-luxury)] group-hover:grayscale-0 group-hover:scale-[1.03]"
        />
      </div>
      {caption && (
        <figcaption className="mt-3 font-serif italic text-sm text-[var(--fg-muted)]">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
