// Event bus for the Zed-style IDE overlay easter egg.
// The command palette, the header "open in zed" button, and the footer
// `$EDITOR` link all fire `openIde()`; the overlay (mounted in the root
// layout) subscribes via `onIdeOpen` / `onIdeClose`.

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
