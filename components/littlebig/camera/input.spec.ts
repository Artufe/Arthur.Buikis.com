import { afterEach, describe, expect, it } from 'vitest';
import { CameraInput } from './input';

const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach((f) => f()); document.body.replaceChildren(); });
function setup() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const input = new CameraInput(canvas, 'page');
  disposals.push(() => input.dispose());
  return { canvas, input };
}
function key(target: Element, type: 'keydown' | 'keyup', code: string) {
  const event = new KeyboardEvent(type, { code, key: code === 'Space' ? ' ' : 'w', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}
describe('camera keyboard ownership', () => {
  it('leaves native HUD activation and navigation to the focused control', () => {
    const { input } = setup();
    const button = document.createElement('button');
    const icon = document.createElement('span');
    button.append(icon);
    document.body.append(button);
    button.focus();
    for (const code of ['Space', 'ArrowLeft', 'KeyW']) {
      expect(key(icon, 'keydown', code).defaultPrevented).toBe(false);
      expect(input.key(code)).toBe(false);
    }
  });
  it('still clears held movement when release occurs on a control', () => {
    const { canvas, input } = setup();
    canvas.focus();
    expect(key(canvas, 'keydown', 'KeyW').defaultPrevented).toBe(true);
    expect(input.key('KeyW')).toBe(true);
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    key(button, 'keyup', 'KeyW');
    expect(input.key('KeyW')).toBe(false);
  });
  it('never turns an interrupted pointer gesture into a tap', () => {
    const { canvas, input } = setup();
    for (const type of ['pointerdown', 'pointercancel']) {
      const e = new Event(type, { bubbles: true });
      Object.assign(e, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 30, clientY: 30 });
      canvas.dispatchEvent(e);
    }
    expect(input.click).toBe(false);
    expect(input.dragging).toBe(false);
  });
});
