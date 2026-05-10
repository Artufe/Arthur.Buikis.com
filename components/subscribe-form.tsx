'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import { site } from '@/content/site';
import { cn } from '@/lib/utils';

type Status = 'idle' | 'sending' | 'success' | 'error';

type Variant = 'panel' | 'inline';

const COPY = {
  eyebrow: 'Subscribe',
  title: 'AI in production, in your inbox.',
  body: 'New notes when they ship. No tracking pixels, no drip funnels — just the post.',
  comingSoon: 'Email signup is wiring up. Bookmark /notes/ for now, or use /contact to nudge me.',
};

// Reject submissions faster than this — humans don't fill and submit in <800ms,
// bots do. Belt-and-braces with the off-screen `_gotcha` honeypot below.
const MIN_DWELL_MS = 800;

export function SubscribeForm({ variant = 'panel', className }: { variant?: Variant; className?: string }) {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const mountedAt = useRef<number>(0);

  useEffect(() => {
    mountedAt.current = Date.now();
  }, []);

  const endpoint = site.subscribeEndpoint;
  const live = !!endpoint;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!endpoint) return;
    const form = e.currentTarget;
    const data = new FormData(form);

    // Honeypot: real users can't see or tab into this; bots fill every field.
    // Pretend we succeeded so they don't retry.
    if ((data.get('_gotcha') as string | null)?.length) {
      setStatus('success');
      form.reset();
      return;
    }

    // Timing trap: bots POST instantly after page load.
    if (mountedAt.current && Date.now() - mountedAt.current < MIN_DWELL_MS) {
      setStatus('success');
      form.reset();
      return;
    }

    setStatus('sending');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: data,
      });
      if (!res.ok) {
        // Formspree returns { errors: [{ message }] } on validation errors;
        // other providers may return plain text. Fall back to status code.
        const payload: unknown = await res.json().catch(() => null);
        const message =
          typeof payload === 'object' &&
          payload !== null &&
          'errors' in payload &&
          Array.isArray((payload as { errors: unknown }).errors) &&
          (payload as { errors: Array<{ message?: string }> }).errors[0]?.message
            ? (payload as { errors: Array<{ message?: string }> }).errors[0].message!
            : `HTTP ${res.status}`;
        throw new Error(message);
      }
      setStatus('success');
      form.reset();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
  }

  const wrapper = cn(
    variant === 'panel'
      ? 'border-2 border-[var(--border)] p-6 sm:p-8'
      : 'pt-10',
    className,
  );

  return (
    <section className={wrapper} aria-labelledby="subscribe-title">
      <p className="mono">{COPY.eyebrow}</p>
      <h2
        id="subscribe-title"
        className="mt-3 font-display text-2xl sm:text-3xl leading-snug"
      >
        {COPY.title}
      </h2>
      <p className="mt-2 dim leading-relaxed max-w-[52ch]">{COPY.body}</p>

      <div role="status" aria-live="polite" aria-atomic="true">
        {status === 'success' && (
          <p className="mt-5 font-display italic text-[17px] ch">
            You&apos;re on the list. Watch your inbox.
          </p>
        )}
        {status === 'error' && (
          <p className="mt-5 font-mono text-[12px] text-red-700 dark:text-red-300">
            Couldn&apos;t subscribe: {errorMsg}
          </p>
        )}
      </div>

      {live ? (
        <form onSubmit={onSubmit} className="mt-6 flex flex-col sm:flex-row gap-3 sm:items-end">
          <input
            type="text"
            name="_gotcha"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            style={{ position: 'absolute', left: '-9999px', width: 0, height: 0 }}
          />
          <div className="flex-1">
            <label htmlFor="subscribe-email" className="mono mb-2 block">
              Email
            </label>
            <Input
              id="subscribe-email"
              name="email"
              type="email"
              required
              placeholder="you@somewhere.co"
              autoComplete="email"
            />
          </div>
          <button
            type="submit"
            disabled={status === 'sending'}
            className="h-11 px-5 border-2 border-[var(--fg)] bg-[var(--fg)] text-[var(--bg)] font-mono text-[12px] uppercase tracking-[0.12em] hover:bg-[var(--accent)] hover:border-[var(--accent)] transition-colors duration-[var(--dur)] disabled:opacity-50 whitespace-nowrap"
          >
            {status === 'sending' ? 'Subscribing…' : 'Subscribe'}
          </button>
        </form>
      ) : (
        <p className="mt-6 font-mono text-[12px] dim leading-relaxed max-w-[52ch]">
          {COPY.comingSoon}
        </p>
      )}

      <p className="mt-4 font-mono text-[10px] dim">
        no spam · unsubscribe anytime
      </p>
    </section>
  );
}
