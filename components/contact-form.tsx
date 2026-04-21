'use client';

import { useState, type FormEvent } from 'react';
import emailjs from '@emailjs/browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { emailjsConfig } from '@/content/emailjs';
import { site } from '@/content/site';

type Status = 'idle' | 'sending' | 'success' | 'error';

export function ContactForm() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setStatus('sending');
    try {
      await emailjs.send(
        emailjsConfig.serviceId,
        emailjsConfig.templateId,
        {
          from_name: data.get('email'),
          user_name: data.get('name'),
          to_name: site.email,
          message: data.get('message'),
        },
        { publicKey: emailjsConfig.userId }
      );
      setStatus('success');
      form.reset();
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'text' in err && typeof err.text === 'string'
          ? err.text
          : err instanceof Error
            ? err.message
            : 'Something went wrong.';
      setErrorMsg(message);
      setStatus('error');
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      {status === 'success' && (
        <p className="font-serif italic text-lg text-[var(--accent)]">Thanks &mdash; I&apos;ll get back to you soon.</p>
      )}
      {status === 'error' && (
        <p className="font-mono text-sm text-red-500">Failed to send: {errorMsg}</p>
      )}
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
