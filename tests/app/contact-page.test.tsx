import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ContactPage from '@/app/contact/page';
import { site } from '@/content/site';

describe('ContactPage', () => {
  it('posts to Formspree', () => {
    const { container } = render(<ContactPage />);
    const form = container.querySelector('form');
    expect(form?.getAttribute('action')).toBe(site.formspreeEndpoint);
    expect(form?.getAttribute('method')).toBe('POST');
  });

  it('includes an off-screen _gotcha honeypot that users cannot tab into', () => {
    const { container } = render(<ContactPage />);
    const honeypot = container.querySelector<HTMLInputElement>('form input[name="_gotcha"]');
    expect(honeypot).not.toBeNull();
    expect(honeypot!.tabIndex).toBe(-1);
    expect(honeypot!.getAttribute('aria-hidden')).toBe('true');
    expect(honeypot!.getAttribute('autocomplete')).toBe('off');
    expect(honeypot!.hasAttribute('required')).toBe(false);
    expect(honeypot!.style.left).toBe('-9999px');
  });
});
