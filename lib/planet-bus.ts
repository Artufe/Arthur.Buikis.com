// LITTLEBIG window events (palette → LittlebigWindowHost), mirroring surf-bus.

const EVENT_OPEN = 'planet:open';
const EVENT_CLOSE = 'planet:close';
const EVENT_RAISE = 'planet:raise';

export function openPlanet() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_OPEN));
}

export function closePlanet() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_CLOSE));
}

export function raisePlanet() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_RAISE));
}

export function onPlanetOpen(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_OPEN, handler);
  return () => window.removeEventListener(EVENT_OPEN, handler);
}

export function onPlanetClose(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_CLOSE, handler);
  return () => window.removeEventListener(EVENT_CLOSE, handler);
}

export function onPlanetRaise(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_RAISE, handler);
  return () => window.removeEventListener(EVENT_RAISE, handler);
}
