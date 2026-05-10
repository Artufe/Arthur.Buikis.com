import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SubscribeForm } from '@/components/subscribe-form';
import { site } from '@/content/site';

const TEST_ENDPOINT = 'https://example.test/subscribe';

describe('SubscribeForm', () => {
  const originalFetch = global.fetch;
  const originalEndpoint = site.subscribeEndpoint;

  beforeEach(() => {
    site.subscribeEndpoint = TEST_ENDPOINT;
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
    site.subscribeEndpoint = originalEndpoint;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('renders the email field and a subscribe button when endpoint is configured', () => {
    render(<SubscribeForm />);
    expect(screen.getByLabelText(/email/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /subscribe/i })).toBeDefined();
  });

  it('renders a "coming soon" CTA and no form when endpoint is empty', () => {
    site.subscribeEndpoint = '';
    render(<SubscribeForm />);
    expect(screen.queryByRole('button', { name: /subscribe/i })).toBeNull();
    expect(screen.getByText(/wiring up/i)).toBeDefined();
  });

  it('shows success state and POSTs to the configured endpoint', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SubscribeForm />);
    // Get past the 800ms dwell-time spam trap.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 't@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));
    await screen.findByText(/on the list/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(TEST_ENDPOINT);
  });

  it('surfaces a server-side error message when the provider rejects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ errors: [{ message: 'Already subscribed' }] }),
      } as unknown as Response)
    );
    render(<SubscribeForm />);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 't@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));
    await screen.findByText(/already subscribed/i);
  });

  it('silently drops submissions that arrive faster than the dwell threshold', async () => {
    render(<SubscribeForm />);
    // Submit immediately — before the 800ms timing trap clears.
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'bot@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));
    await screen.findByText(/on the list/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('silently drops submissions when the honeypot is filled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = render(<SubscribeForm />);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    const honeypot = container.querySelector('input[name="_gotcha"]') as HTMLInputElement;
    expect(honeypot).toBeDefined();
    fireEvent.change(honeypot, { target: { value: 'http://spammy.example' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'bot@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));
    await screen.findByText(/on the list/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
