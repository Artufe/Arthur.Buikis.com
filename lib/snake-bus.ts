const EVENT_OPEN = 'snake:open';
const EVENT_CLOSE = 'snake:close';
const EVENT_RAISE = 'snake:raise';

export function openSnake() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_OPEN));
}

export function closeSnake() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_CLOSE));
}

export function raiseSnake() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_RAISE));
}

export function onSnakeOpen(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_OPEN, handler);
  return () => window.removeEventListener(EVENT_OPEN, handler);
}

export function onSnakeClose(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_CLOSE, handler);
  return () => window.removeEventListener(EVENT_CLOSE, handler);
}

export function onSnakeRaise(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_RAISE, handler);
  return () => window.removeEventListener(EVENT_RAISE, handler);
}
