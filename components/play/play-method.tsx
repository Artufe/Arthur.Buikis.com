import { Fragment, type ReactNode } from 'react';
import { method, type PlayLane } from '@/content/play';
import { ScrollReveal } from '@/components/scroll-reveal';
import { cn } from '@/lib/utils';

const node = 'border-[1.5px] border-[var(--border)] px-2.5 py-1.5';

function Conn() {
  return <div aria-hidden="true" className="ml-[18px] h-4 border-l-[1.5px] border-[var(--muted)]" />;
}

function Lane({ id, name }: PlayLane) {
  return (
    <span>
      <span className="mr-1 text-[var(--accent)]">{id}</span>
      {name}
    </span>
  );
}

function Phase({ label, note, children }: { label: string; note: string; children: ReactNode }) {
  return (
    <div className="border-[1.5px] border-dashed border-[var(--muted)] p-2.5">
      <div className="mb-2 flex justify-between text-[9px] uppercase tracking-[0.14em] dim">
        <span>{label}</span>
        <span>{note}</span>
      </div>
      {children}
    </div>
  );
}

export function PlayMethod() {
  const { oneShot, orchestrated, mine, sources } = method;
  const { pipeline } = orchestrated;

  return (
    <section
      aria-labelledby="play-method-h"
      className="mx-auto max-w-[1600px] px-6 py-20 lg:px-16 lg:py-28"
      style={{ borderTop: '2px solid var(--border)' }}
    >
      <ScrollReveal>
        <div className="font-mono text-[12px] text-[var(--muted)] tracking-wide" aria-hidden>
          <span className="text-[var(--accent)] mr-2">$</span>cat HOW-IT-WAS-BUILT.md
        </div>
        <h2 id="play-method-h" className="mt-3.5">
          How these were built.
        </h2>

        <div className="mt-11 grid gap-12 lg:grid-cols-2">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--accent)]">{oneShot.tag}</p>
            <h3 className="mt-2.5 text-[28px] leading-[1.1]">{oneShot.title}</h3>
            <p className="mt-3 max-w-[56ch] text-[13px] leading-[1.7] dim">{oneShot.body}</p>
            <ol className="mt-5 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
              {oneShot.chain.map((step, i) => (
                <li key={step.label} className="flex items-center gap-1.5">
                  {i > 0 && (
                    <span className="dim" aria-hidden="true">
                      →
                    </span>
                  )}
                  <span className={cn(node, step.highlight && 'border-[var(--accent)] text-[var(--accent)]')}>
                    {step.label}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 font-mono text-[11px] dim">{oneShot.scores}</p>
          </div>

          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--accent)]">
              {orchestrated.tag}
            </p>
            <h3 className="mt-2.5 text-[28px] leading-[1.1]">{orchestrated.title}</h3>
            <p className="mt-3 max-w-[56ch] text-[13px] leading-[1.7] dim">{orchestrated.body}</p>

            <div className="mt-5 font-mono text-[10.5px]">
              <div className="flex gap-2">
                {pipeline.head.map((b, i) => (
                  <div key={b.label} className={cn(node, i === pipeline.head.length - 1 && 'flex-1')}>
                    {b.label}
                    <small className="mt-0.5 block text-[9px] dim">{b.note}</small>
                  </div>
                ))}
              </div>
              <Conn />
              <Phase label={pipeline.phaseA.label} note={pipeline.phaseA.note}>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {pipeline.phaseA.lanes.map((lane) => (
                    <div key={lane.id} className={cn(node, 'px-2 text-[10px] leading-[1.4]')}>
                      <Lane {...lane} />
                    </div>
                  ))}
                  <div className={cn(node, 'col-span-full flex flex-wrap items-center gap-1.5 px-2 text-[10px]')}>
                    {pipeline.phaseA.chain.map((lane, i) => (
                      <Fragment key={lane.id}>
                        {i > 0 && (
                          <span className="dim" aria-hidden="true">
                            →
                          </span>
                        )}
                        <Lane {...lane} />
                      </Fragment>
                    ))}
                  </div>
                </div>
              </Phase>
              <Conn />
              <div className="flex flex-wrap gap-1.5">
                {pipeline.gates.map((g) => (
                  <span key={g} className={node}>
                    {g}
                  </span>
                ))}
              </div>
              <Conn />
              <Phase label={pipeline.phaseB.label} note={pipeline.phaseB.note}>
                <div className="grid grid-cols-2 gap-1.5">
                  {pipeline.phaseB.lanes.map((lane) => (
                    <div key={lane.id} className={cn(node, 'px-2 text-[10px] leading-[1.4]')}>
                      <Lane {...lane} />
                    </div>
                  ))}
                </div>
              </Phase>
              <Conn />
              <div className="flex gap-2">
                {pipeline.tail.map((t) => (
                  <span key={t} className={node}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div
          className="mt-14 grid gap-7 pt-6 lg:grid-cols-[1fr_2.5fr] lg:gap-14"
          style={{ borderTop: '2px solid var(--border)' }}
        >
          <div>
            <p className="mono" style={{ margin: '0 0 10px' }}>
              My part
            </p>
            <p className="text-[12px] leading-[1.6] dim" style={{ margin: 0 }}>
              The agents wrote the code.
              <br />
              This is what I did.
            </p>
          </div>
          <div className="min-w-0">
            <ol className="grid grid-cols-2 border-l-2 border-t-2 border-[var(--border)] lg:grid-cols-4">
              {mine.map((step, i) => (
                <li key={step} className="border-b-2 border-r-2 border-[var(--border)] px-3.5 py-4 text-[12.5px] leading-[1.5]">
                  <span className="mb-2 block text-[10px] tracking-[0.1em] text-[var(--accent)]">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
            <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px]">
              {sources.map((s) => (
                <a
                  key={s.href}
                  href={s.href}
                  target="_blank"
                  rel="noreferrer"
                  className="dim underline underline-offset-4 decoration-[var(--border)] hover:text-[var(--accent)] transition-colors duration-[var(--dur)]"
                >
                  {s.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}
