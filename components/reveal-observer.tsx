'use client';

import { useEffect } from 'react';

// Pages render bare `className="reveal"` elements (about, building, notes)
// that globals.css keeps at opacity 0 until `vis` is added. ScrollReveal only
// covers its own wrapped children, so this observer handles everything else —
// including elements added later by client-side navigation.
export function RevealObserver() {
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const seen = new WeakSet<Element>();

    const io =
      !reduced && 'IntersectionObserver' in window
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                // Reveal when intersecting, or when already scrolled past
                // (e.g. landing mid-page via an anchor).
                if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
                  entry.target.classList.add('vis');
                  io?.unobserve(entry.target);
                }
              }
            },
            { threshold: 0.1, rootMargin: '0px 0px -60px 0px' }
          )
        : null;

    const observe = (root: ParentNode) => {
      const targets: Element[] = [];
      if (root instanceof Element && root.matches('.reveal:not(.vis)')) targets.push(root);
      targets.push(...root.querySelectorAll('.reveal:not(.vis)'));
      for (const el of targets) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (io) io.observe(el);
        else el.classList.add('vis');
      }
    };

    observe(document);

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof Element) observe(node);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      io?.disconnect();
      mo.disconnect();
    };
  }, []);

  return null;
}
