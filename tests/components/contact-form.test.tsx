import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContactForm } from '@/components/contact-form';

describe('ContactForm', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      } as unknown as Response)
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('renders name, email, message fields and submit button', () => {
    render(<ContactForm />);
    expect(screen.getByLabelText(/name/i)).toBeDefined();
    expect(screen.getByLabelText(/email/i)).toBeDefined();
    expect(screen.getByLabelText(/message/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /send/i })).toBeDefined();
  });

  it('shows success alert after submit', async () => {
    render(<ContactForm />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 't@x.com' } });
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByText(/thanks/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('shows error message when server returns non-2xx', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ errors: [{ message: 'Server error' }] }),
      } as unknown as Response)
    );
    render(<ContactForm />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 't@x.com' } });
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByText(/server error/i);
  });
});
