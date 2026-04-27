'use client';

import { useState, type FormEvent } from 'react';
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

export function SubscribeForm({ variant = 'panel', className }: { variant?: Variant; className?: string }) {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const endpoint = site.subscribeEndpoint;
  const live = !!endpoint;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!endpoint) return;
    const form = e.currentTarget;
    setStatus('sending');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new FormData(form),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus('success');
      form.reset();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
  }

  const wrapper = cn(
    variant === 'panel'
      ? 'border border-[var(--rule-strong)] bg-[var(--card)] p-6 sm:p-8'
      : 'border-t border-[var(--rule-strong)] pt-10',
    className,
  );
  const wrapperStyle = variant === 'panel' ? { boxShadow: 'var(--panel-shadow)' } : undefined;

  return (
    <section className={wrapper} style={wrapperStyle} aria-labelledby="subscribe-title">
      <p className="lbl">{COPY.eyebrow}</p>
      <h2
        id="subscribe-title"
        className="mt-3 font-serif text-2xl sm:text-3xl leading-snug"
      >
        {COPY.title}
      </h2>
      <p className="mt-2 text-[var(--fg-muted)] leading-relaxed max-w-[52ch]">{COPY.body}</p>

      <div role="status" aria-live="polite" aria-atomic="true">
        {status === 'success' && (
          <p className="mt-5 font-serif italic text-[17px] text-[var(--accent)]">
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
            <label htmlFor="subscribe-email" className="lbl mb-2 block">
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
            className="h-11 px-5 bg-[var(--fg)] text-[var(--bg)] font-sans text-[11px] tracking-wide uppercase hover:bg-[var(--accent)] focus-visible:bg-[var(--accent)] transition-colors duration-[var(--dur-fast)] disabled:opacity-50 sm:self-end whitespace-nowrap"
          >
            {status === 'sending' ? 'Subscribing…' : 'Subscribe'}
          </button>
        </form>
      ) : (
        <p className="mt-6 font-mono text-[12px] text-[var(--fg-faint)] leading-relaxed max-w-[52ch]">
          {COPY.comingSoon}
        </p>
      )}

      <p className="mt-4 font-mono text-[10px] text-[var(--fg-faint)]">
        no spam · unsubscribe anytime
      </p>
    </section>
  );
}
