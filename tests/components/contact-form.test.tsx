import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContactForm } from '@/components/contact-form';

vi.mock('@emailjs/browser', () => ({ default: { send: vi.fn().mockResolvedValue({ status: 200, text: 'OK' }) } }));

describe('ContactForm', () => {
  it('renders name, email, message fields and submit button', () => {
    render(<ContactForm />);
    expect(screen.getByPlaceholderText(/name/i)).toBeDefined();
    expect(screen.getByPlaceholderText(/email/i)).toBeDefined();
    expect(screen.getByPlaceholderText(/message/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /send/i })).toBeDefined();
  });
  it('shows success alert after submit', async () => {
    render(<ContactForm />);
    fireEvent.change(screen.getByPlaceholderText(/name/i), { target: { value: 'Test' } });
    fireEvent.change(screen.getByPlaceholderText(/email/i), { target: { value: 't@x.com' } });
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByText(/thanks/i);
  });
});
