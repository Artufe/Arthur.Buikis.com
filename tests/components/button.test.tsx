import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '@/components/ui/button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeDefined();
  });
  it('applies primary variant by default', () => {
    render(<Button data-testid="btn">X</Button>);
    const el = screen.getByTestId('btn');
    expect(el.className).toContain('bg-[var(--fg)]');
  });
  it('applies secondary variant', () => {
    render(<Button variant="secondary" data-testid="btn">X</Button>);
    const el = screen.getByTestId('btn');
    expect(el.className).toContain('border');
  });
});
