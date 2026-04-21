'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { site } from '@/content/site';

type Status = 'idle' | 'sending' | 'success' | 'error';

export function ContactForm() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
          typeof data === 'object' && data !== null && 'errors' in data && Array.isArray(data.errors) && data.errors[0]?.message
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
  }

  return (
    <form
      onSubmit={onSubmit}
      action={site.formspreeEndpoint}
      method="POST"
      className="space-y-8"
    >
      {status === 'success' && (
        <p className="font-serif italic text-lg text-[var(--accent)]">
          Thanks &mdash; I&apos;ll get back to you soon.
        </p>
      )}
      {status === 'error' && (
        <p className="font-mono text-sm text-red-500">Failed to send: {errorMsg}</p>
      )}
      <input type="hidden" name="_subject" value="New message from buikis.com" />
      <input
        type="text"
        name="_gotcha"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        style={{ position: 'absolute', left: '-9999px', width: 0, height: 0 }}
      />
      <div className="grid gap-8 md:grid-cols-2">
        <Input name="name" placeholder="Name" type="text" required />
        <Input name="email" placeholder="Email" type="email" required />
      </div>
      <Textarea name="message" placeholder="Your message..." rows={5} required />
      <Button type="submit" disabled={status === 'sending'}>
        {status === 'sending' ? 'Sending…' : 'Send'}
      </Button>
    </form>
  );
}
