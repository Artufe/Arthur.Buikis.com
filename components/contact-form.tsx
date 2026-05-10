'use client';

import { useState, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { site } from '@/content/site';

type Status = 'idle' | 'sending' | 'success' | 'error';

export function ContactForm() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    e.stopPropagation();
    const form = e.currentTarget;
    setStatus('sending');
    try {
      const res = await fetch(site.formspreeEndpoint, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new FormData(form),
      });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        const message =
          typeof data === 'object' &&
          data !== null &&
          'errors' in data &&
          Array.isArray(data.errors) &&
          data.errors[0]?.message
            ? data.errors[0].message
            : `HTTP ${res.status}`;
        throw new Error(message);
      }
      setStatus('success');
      form.reset();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
    return false;
  }

  return (
    <div className="card" style={{ padding: '24px' }}>
      <div className="flex items-baseline justify-between" style={{ borderBottom: '2px solid var(--border)', paddingBottom: 12, marginBottom: 20 }}>
        <span className="mono">
          <span className="ch mr-2">$</span>compose_message
        </span>
        <span className="font-mono text-[10px] dim">sent via formspree · no tracking</span>
      </div>

      <div role="status" aria-live="polite" aria-atomic="true">
        {status === 'success' && (
          <p className="mb-5 font-display italic text-[17px] ch">
            Thanks — I&apos;ll get back to you soon.
          </p>
        )}
        {status === 'error' && (
          <p className="mb-5 font-mono text-[12px] text-red-700 dark:text-red-300">
            Failed to send: {errorMsg}
          </p>
        )}
      </div>

      <form onSubmit={onSubmit} className="space-y-6">
        <input type="hidden" name="_subject" value="New message from buikis.com" />
        <input
          type="text"
          name="_gotcha"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          style={{ position: 'absolute', left: '-9999px', width: 0, height: 0 }}
        />
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <label htmlFor="name" className="mono block mb-2">Name</label>
            <Input id="name" name="name" type="text" placeholder="e.g. Anna" required />
          </div>
          <div>
            <label htmlFor="email" className="mono block mb-2">Email</label>
            <Input id="email" name="email" type="email" placeholder="anna@somewhere.co" required />
          </div>
        </div>
        <div>
          <label htmlFor="message" className="mono block mb-2">Message</label>
          <Textarea id="message" name="message" rows={6} placeholder="What are you building? What's in the way?" required />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
          <button
            type="submit"
            disabled={status === 'sending'}
            className="h-11 px-5 border-2 border-[var(--fg)] bg-[var(--fg)] text-[var(--bg)] font-mono text-[12px] uppercase tracking-[0.12em] hover:bg-[var(--accent)] hover:border-[var(--accent)] transition-colors duration-[var(--dur)] disabled:opacity-50"
          >
            {status === 'sending' ? 'Sending…' : 'Send message'}
          </button>
          <span className="font-mono text-[10px] dim inline-flex items-center gap-2">
            <span className="kbd">/</span>
            or use commands anywhere
          </span>
        </div>
      </form>
    </div>
  );
}
