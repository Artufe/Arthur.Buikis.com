import type { MDXComponents } from 'mdx/types';
import { Callout } from '@/components/mdx/callout';
import { Figure } from '@/components/mdx/figure';
import { CodeBlock } from '@/components/mdx/code-block';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...components,
    h1: ({ children }) => <h1 className="font-serif text-5xl lg:text-6xl leading-[1.02] mt-0 mb-6">{children}</h1>,
    h2: ({ children }) => <h2 className="font-serif text-3xl lg:text-4xl leading-tight mt-16 mb-4">{children}</h2>,
    h3: ({ children }) => <h3 className="font-serif text-xl lg:text-2xl mt-10 mb-3">{children}</h3>,
    p: ({ children }) => <p className="my-5 leading-[1.75]">{children}</p>,
    a: ({ href, children }) => (
      <a href={href} className="underline decoration-[var(--fg)]/30 underline-offset-4 hover:text-[var(--accent)] hover:decoration-[var(--accent)] transition-colors duration-[var(--dur-fast)]">
        {children}
      </a>
    ),
    ul: ({ children }) => <ul className="my-5 space-y-2 list-none pl-0">{children}</ul>,
    li: ({ children }) => <li className="pl-5 relative before:absolute before:left-0 before:top-[0.7em] before:w-2 before:h-px before:bg-[var(--fg)]/50">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-8 border-l-2 border-[var(--accent)] pl-6 font-serif italic text-xl leading-snug">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-12 border-0 border-t border-[var(--fg)]/15" />,
    Callout,
    Figure,
    CodeBlock,
  };
}
