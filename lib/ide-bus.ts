// Open Design's IDE-mode easter egg.
// The CommandPalette and the footer link both fire `openIde()`; the overlay
// component (mounted in layout) subscribes via `onIdeOpen` / `onIdeClose`.

const OPEN_EVENT = 'ide:open';
const CLOSE_EVENT = 'ide:close';

export function openIde() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function closeIde() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
}

export function onIdeOpen(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}

export function onIdeClose(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(CLOSE_EVENT, handler);
  return () => window.removeEventListener(CLOSE_EVENT, handler);
}
