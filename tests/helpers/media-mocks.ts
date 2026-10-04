// jsdom has no IntersectionObserver or matchMedia, and HTMLMediaElement.play/pause aren't
// implemented. These fakes let tests drive visibility, reduced motion and tab visibility by hand.
import { act } from '@testing-library/react';
import { vi } from 'vitest';

type Observer = { cb: IntersectionObserverCallback; els: Set<Element> };

const observers: Observer[] = [];
const mqListeners = new Set<() => void>();
let reduce = false;
let hidden = false;

export function installMediaMocks() {
  observers.length = 0;
  mqListeners.clear();
  reduce = false;
  hidden = false;

  vi.stubGlobal(
    'IntersectionObserver',
    class {
      root = null;
      rootMargin = '';
      thresholds = [];
      private o: Observer;
      constructor(cb: IntersectionObserverCallback) {
        this.o = { cb, els: new Set() };
        observers.push(this.o);
      }
      observe(el: Element) { this.o.els.add(el); }
      unobserve(el: Element) { this.o.els.delete(el); }
      disconnect() { this.o.els.clear(); }
      takeRecords() { return []; }
    },
  );

  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduce : false,
    media: query,
    onchange: null,
    addEventListener: (_type: string, l: () => void) => mqListeners.add(l),
    removeEventListener: (_type: string, l: () => void) => mqListeners.delete(l),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

  const played: HTMLMediaElement[] = [];
  const paused: HTMLMediaElement[] = [];
  const play = vi
    .spyOn(HTMLMediaElement.prototype, 'play')
    .mockImplementation(function (this: HTMLMediaElement) {
      played.push(this);
      return Promise.resolve();
    });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    paused.push(this);
  });
  return { played, paused, play };
}

export function setInView(el: Element, isIntersecting: boolean) {
  act(() => {
    for (const o of observers) {
      if (!o.els.has(el)) continue;
      o.cb([{ isIntersecting, target: el } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
}

export function setReducedMotion(on: boolean) {
  reduce = on;
  act(() => mqListeners.forEach((l) => l()));
}

export function setPageHidden(on: boolean) {
  hidden = on;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
