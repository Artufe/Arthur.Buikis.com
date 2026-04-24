const EVENT_OPEN = 'palette:open';
const EVENT_CLOSE = 'palette:close';

export function openPalette(initialQuery = '') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_OPEN, { detail: { initialQuery } }));
}

export function closePalette() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_CLOSE));
}

export function onPaletteOpen(handler: (initialQuery: string) => void) {
  if (typeof window === 'undefined') return () => {};
  const wrapped = (e: Event) => {
    const detail = (e as CustomEvent<{ initialQuery?: string }>).detail;
    handler(detail?.initialQuery ?? '');
  };
  window.addEventListener(EVENT_OPEN, wrapped);
  return () => window.removeEventListener(EVENT_OPEN, wrapped);
}

export function onPaletteClose(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_CLOSE, handler);
  return () => window.removeEventListener(EVENT_CLOSE, handler);
}
