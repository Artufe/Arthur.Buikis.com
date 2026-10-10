import { expect, it, vi } from 'vitest';
import { FrameEvents } from './frame-events';

it('only delivers engine frames and removes subscribers on unsubscribe or disposal', () => {
  const frames = new FrameEvents();
  const listener = vi.fn();
  const off = frames.subscribe(listener);
  expect(listener).not.toHaveBeenCalled();
  frames.emit(100);
  expect(listener).toHaveBeenLastCalledWith(100);
  off();
  frames.emit(200);
  expect(listener).toHaveBeenCalledTimes(1);
  frames.subscribe(listener);
  frames.dispose();
  frames.subscribe(listener);
  frames.emit(300);
  expect(listener).toHaveBeenCalledTimes(1);
});

it('isolates a failed overlay without stopping later subscribers', () => {
  const frames = new FrameEvents();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const bad = vi.fn(() => { throw new Error('overlay'); });
  const good = vi.fn();
  frames.subscribe(bad);
  frames.subscribe(good);
  frames.emit(1);
  frames.emit(2);
  expect(bad).toHaveBeenCalledTimes(1);
  expect(good).toHaveBeenCalledTimes(2);
  error.mockRestore();
});
