import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn(), resolvedTheme: 'dark' }),
}));

// In the browser the palette mounts ~300ms after the keypress that loads it
// (chunk import plus React's Suspense reveal throttle), even when prefetched.
// next/dynamic with ssr:false is React.lazy behind Suspense; this stand-in adds
// that delay to every dynamic() call, so no test depends on how fast jsdom
// resolves the import or on what an earlier test already loaded.
vi.mock('next/dynamic', async () => {
  const { createElement, lazy, Suspense } = await import('react');
  return {
    default: (loader: () => Promise<{ default: React.ComponentType<object> }>) => {
      const Lazy = lazy(() => new Promise((r) => setTimeout(r, 300)).then(loader));
      return function Dynamic(props: object) {
        return createElement(Suspense, { fallback: null }, createElement(Lazy, props));
      };
    },
  };
});

const OPEN_TIMEOUT = { timeout: 2000 };

async function renderLazy(before?: React.ReactNode) {
  // Fresh modules per test so each one starts with the palette unloaded.
  vi.resetModules();
  const { CommandPaletteLazy } = await import('@/components/command-palette-lazy');
  render(
    <>
      {before}
      <CommandPaletteLazy />
    </>
  );
}

beforeEach(() => {
  // jsdom has no matchMedia; the palette's "press / for commands" hint reads it.
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
});

afterEach(cleanup);

describe('CommandPaletteLazy', () => {
  it('opens and focuses the palette on the first / press', async () => {
    await renderLazy();
    fireEvent.keyDown(window, { key: '/' });
    const input = await screen.findByLabelText('Command palette', {}, OPEN_TIMEOUT);
    expect(document.activeElement).toBe(input);
  });

  it('opens the palette on the first Ctrl+K press', async () => {
    await renderLazy();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByLabelText('Command palette', {}, OPEN_TIMEOUT)).toBeDefined();
  });

  it('opens the palette with its query on the first palette:open event', async () => {
    await renderLazy();
    window.dispatchEvent(new CustomEvent('palette:open', { detail: { initialQuery: 'snake' } }));
    const input = await screen.findByLabelText('Command palette', {}, OPEN_TIMEOUT);
    expect((input as HTMLInputElement).value).toBe('snake');
  });

  it('ignores / typed into a form field', async () => {
    await renderLazy(<input aria-label="name" />);
    fireEvent.keyDown(screen.getByLabelText('name'), { key: '/' });
    await new Promise((r) => setTimeout(r, 600));
    expect(screen.queryByLabelText('Command palette')).toBeNull();
  });
});
