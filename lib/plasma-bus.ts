export type PlasmaMode = 'calm' | 'vivid';

const STORAGE_KEY = 'plasma-mode';
const EVENT = 'plasma:mode';

export function getPlasmaMode(): PlasmaMode {
  if (typeof window === 'undefined') return 'vivid';
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'calm' ? 'calm' : 'vivid';
}

export function setPlasmaMode(mode: PlasmaMode) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

export function onPlasmaModeChange(handler: (mode: PlasmaMode) => void) {
  if (typeof window === 'undefined') return () => {};
  const wrapped = (e: Event) => handler((e as CustomEvent<PlasmaMode>).detail);
  window.addEventListener(EVENT, wrapped);
  return () => window.removeEventListener(EVENT, wrapped);
}
