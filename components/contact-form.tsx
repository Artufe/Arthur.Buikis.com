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
    <div
      className="border border-[var(--rule-strong)] bg-[var(--card)] p-6 sm:p-8"
      style={{ boxShadow: 'var(--panel-shadow)' }}
    >
      <div className="flex items-baseline justify-between border-b border-[var(--rule)] pb-3.5 mb-6">
        <span className="lbl">
          <span className="text-[var(--accent)] mr-2">$</span>compose_message
        </span>
        <span className="font-mono text-[10px] text-[var(--fg-faint)]">sent via formspree · no tracking</span>
      </div>

      {status === 'success' && (
        <p className="mb-5 font-serif italic text-[17px] text-[var(--accent)]">
          Thanks — I&apos;ll get back to you soon.
        </p>
      )}
      {status === 'error' && (
        <p className="mb-5 font-mono text-[12px] text-red-400">Failed to send: {errorMsg}</p>
      )}

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
            <label htmlFor="name" className="lbl mb-2 block">Name</label>
            <Input id="name" name="name" type="text" placeholder="e.g. Anna" required />
          </div>
          <div>
            <label htmlFor="email" className="lbl mb-2 block">Email</label>
            <Input id="email" name="email" type="email" placeholder="anna@somewhere.co" required />
          </div>
        </div>
        <div>
          <label htmlFor="message" className="lbl mb-2 block">Message</label>
          <Textarea id="message" name="message" rows={6} placeholder="What are you building? What's in the way?" required />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
          <button
            type="submit"
            disabled={status === 'sending'}
            className="h-11 px-5 bg-[var(--fg)] text-[var(--bg)] font-sans text-[11px] tracking-wide uppercase hover:bg-[var(--accent)] transition-colors duration-[var(--dur-fast)] disabled:opacity-50"
          >
            {status === 'sending' ? 'Sending…' : 'Send message'}
          </button>
          <span className="font-mono text-[10px] text-[var(--fg-faint)] inline-flex items-center gap-2">
            <span className="kbd">/</span>
            or use commands anywhere
          </span>
        </div>
      </form>
    </div>
  );
}
