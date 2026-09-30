const EVENT_OPEN = 'surf:open';
const EVENT_CLOSE = 'surf:close';
const EVENT_RAISE = 'surf:raise';

export function openSurf() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_OPEN));
}

export function closeSurf() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_CLOSE));
}

export function raiseSurf() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_RAISE));
}

export function onSurfOpen(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_OPEN, handler);
  return () => window.removeEventListener(EVENT_OPEN, handler);
}

export function onSurfClose(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_CLOSE, handler);
  return () => window.removeEventListener(EVENT_CLOSE, handler);
}

export function onSurfRaise(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_RAISE, handler);
  return () => window.removeEventListener(EVENT_RAISE, handler);
}
