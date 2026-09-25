import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InitialsEntry } from './initials-entry';

function type(key: string) {
  fireEvent.keyDown(document.body, { key });
}

describe('InitialsEntry', () => {
  it('types letters into the slots and submits on Enter', () => {
    const onSubmit = vi.fn();
    render(<InitialsEntry initial="" onSubmit={onSubmit} />);
    type('r');
    type('m');
    type('w');
    type('Enter');
    expect(onSubmit).toHaveBeenCalledWith('RMW');
  });

  it('swallows game keys so the host never sees them', () => {
    const host = vi.fn();
    window.addEventListener('keydown', host);
    render(<InitialsEntry initial="" onSubmit={() => {}} />);
    for (const key of ['r', 'm', ' ', 'w', 'a', 's', 'd', 'ArrowUp']) type(key);
    window.removeEventListener('keydown', host);
    expect(host).not.toHaveBeenCalled();
  });

  it('starts from the last initials and cycles letters with the buttons', () => {
    const onSubmit = vi.fn();
    render(<InitialsEntry initial="ab1" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'next letter for slot 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'save initials' }));
    expect(onSubmit).toHaveBeenCalledWith('ABB');
  });

  it('backspace moves back a slot', () => {
    const onSubmit = vi.fn();
    render(<InitialsEntry initial="" onSubmit={onSubmit} />);
    type('x');
    type('y');
    type('Backspace');
    type('z');
    type('Enter');
    expect(onSubmit).toHaveBeenCalledWith('XZA');
  });
});
