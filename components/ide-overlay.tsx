'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { onIdeClose, onIdeOpen } from '@/lib/ide-bus';
import {
  antiList,
  atAGlance,
  beliefs,
  stackGroups,
  timeline,
  throughline,
} from '@/content/about';
import { site } from '@/content/site';

type FileKind = 'md' | 'json';

type IdeFile = {
  path: string;       // unique key + display path
  label: string;      // tab label
  kind: FileKind;
  raw: string;
  preview: () => React.ReactElement;
};

// === file definitions ============================================
// Each file gets:
//   raw     — what shows in source mode (markdown / JSON text)
//   preview — what renders in preview mode (nice typography)
// `path` is also the unique key + label in the file tree.

const FILES: IdeFile[] = [
  {
    path: 'README.md',
    label: 'README.md',
    kind: 'md',
    raw: `# Arthur Buikis

> Senior software engineer · Riga, LV · since 2015

Backend & platform engineer. Python with a Rust accent.
Currently shipping a media-processing platform in Riga.
Twelve-ish years writing software you don't notice.

## now
- ${site.bio.jobTitle.toLowerCase()} · since 2024
- python + rust + kubernetes

## contact
- email: ${site.email}
- github · linkedin · upwork

> "The best engineers I've worked with are boring to watch.
>  They delete more than they add."`,
    preview: () => (
      <article style={previewProse}>
        <h1 style={previewH1}>Arthur Buikis</h1>
        <p style={previewLede}>
          Senior software engineer · Riga, LV · since 2015
        </p>
        <p style={{ marginBottom: 18 }}>
          Backend &amp; platform engineer. Python with a Rust accent. Currently
          shipping a media-processing platform in Riga. Twelve-ish years writing
          software you don&apos;t notice.
        </p>

        <h2 style={previewH2}>Now</h2>
        <ul style={previewList}>
          <li>
            <span style={previewBullet}>›</span>
            <span style={{ color: 'var(--ide-green)' }}>●</span>{' '}
            {site.bio.jobTitle.toLowerCase()} · since 2024
          </li>
          <li>
            <span style={previewBullet}>›</span>
            python · rust · kubernetes
          </li>
        </ul>

        <h2 style={previewH2}>Contact</h2>
        <ul style={previewList}>
          <li>
            <span style={previewBullet}>›</span>
            <span style={{ color: 'var(--ide-blue)' }}>{site.email}</span>
          </li>
          {site.socials.map((s) => (
            <li key={s.href}>
              <span style={previewBullet}>›</span>
              {s.label.toLowerCase()} ↗
            </li>
          ))}
        </ul>

        <blockquote style={previewQuote}>
          &ldquo;The best engineers I&apos;ve worked with are boring to watch. They
          delete more than they add.&rdquo;
        </blockquote>
      </article>
    ),
  },

  {
    path: 'about/about.md',
    label: 'about.md',
    kind: 'md',
    raw: `# About

> Backend & platform engineer · Riga · twelve-ish years in

It began on Upwork in 2015. The first jobs were small —
scrapers, automation, the kind of thing people pay for when
their spreadsheet has finally lost the argument.

Three years in came strange-logic — a US domain-intelligence
shop. By the second stint in 2021, the work had grown legs:
a PHP-to-Python rewrite, ClickHouse brought in, and the
Expired Domain Search pipeline that eventually crawled ~700M
domains and stored 43 TB across twelve servers.

Side products in parallel. MyProxy (2020–22) brought
cost-per-GB down ~20× over its run. MarkFlow remains live.

Since 2024 — Riga media-processing platform.
Python + Rust now, virtual tours, Kubernetes plumbing.

Remote-friendly to EU-time teams. Available for the right
next thing only when the current role naturally winds.`,
    preview: () => (
      <article style={previewProse}>
        <h1 style={previewH1}>About</h1>
        <p style={previewLede}>
          Backend &amp; platform engineer · Riga · twelve-ish years in
        </p>

        <p style={{ marginBottom: 14 }}>
          It began on Upwork in 2015. The first jobs were small — scrapers,
          automation, the kind of thing people pay for when their spreadsheet
          has finally lost the argument.
        </p>

        <p style={{ marginBottom: 14 }}>
          Three years in came{' '}
          <span style={{ color: 'var(--ide-blue)' }}>strange-logic</span> — a US
          domain-intelligence shop. By the second stint in 2021, the work had
          grown legs: a PHP-to-Python rewrite, ClickHouse brought in, and the
          Expired Domain Search pipeline that eventually crawled ~700M domains
          and stored 43 TB across twelve servers.
        </p>

        <p style={{ marginBottom: 14 }}>
          Side products in parallel.{' '}
          <span style={{ color: 'var(--ide-blue)' }}>MyProxy</span> (2020–22)
          brought cost-per-GB down ~20× over its run.{' '}
          <span style={{ color: 'var(--ide-blue)' }}>MarkFlow</span> remains{' '}
          <span style={{ color: 'var(--ide-green)' }}>live</span>.
        </p>

        <p style={{ marginBottom: 14 }}>
          Since 2024 — Riga media-processing platform. Python + Rust now,
          virtual tours, Kubernetes plumbing.
        </p>

        <p>
          Remote-friendly to EU-time teams. Available for the right next thing
          only when the current role naturally winds.
        </p>

        <hr style={previewRule} />

        <h2 style={previewH2}>At a glance</h2>
        <dl style={previewKVList}>
          {atAGlance.map((row) => (
            <div key={row.k} style={previewKVRow}>
              <dt style={previewKVKey}>{row.k}</dt>
              <dd style={previewKVValue}>{row.v}</dd>
            </div>
          ))}
        </dl>
      </article>
    ),
  },

  {
    path: 'about/beliefs.md',
    label: 'beliefs.md',
    kind: 'md',
    raw: `# beliefs

About software, mostly.

${beliefs.map((b, i) => `${String(i + 1).padStart(2, '0')}. ${b}`).join('\n')}`,
    preview: () => (
      <article style={previewProse}>
        <h1 style={previewH1}>Beliefs</h1>
        <p style={previewLede}>About software, mostly.</p>
        <ol style={previewOl}>
          {beliefs.map((b, i) => (
            <li key={i} style={previewOlItem}>
              <span style={previewOlNum}>{String(i + 1).padStart(2, '0')}</span>
              <span>{b}</span>
            </li>
          ))}
        </ol>
      </article>
    ),
  },

  {
    path: 'about/anti-list.md',
    label: 'anti-list.md',
    kind: 'md',
    raw: `# avoid

In this order.

${antiList.map((a, i) => `${String(i + 1).padStart(2, '0')}. ${a}`).join('\n')}`,
    preview: () => (
      <article style={previewProse}>
        <h1 style={previewH1}>Avoid</h1>
        <p style={previewLede}>In this order.</p>
        <ol style={previewOl}>
          {antiList.map((a, i) => (
            <li key={i} style={previewOlItem}>
              <span style={{ ...previewOlNum, color: 'var(--ide-red)' }}>×</span>
              <span>{a}</span>
            </li>
          ))}
        </ol>
      </article>
    ),
  },

  {
    path: 'stack.json',
    label: 'stack.json',
    kind: 'json',
    raw: JSON.stringify(
      Object.fromEntries(
        stackGroups.map((g) => [
          g.title.toLowerCase().replace(/\s+/g, '_'),
          { items: g.items, note: g.note },
        ]),
      ),
      null,
      2,
    ),
    preview: () => (
      <article style={previewProse}>
        <h1 style={previewH1}>Stack</h1>
        <p style={previewLede}>On the keyboard this month.</p>
        <div style={{ display: 'grid', gap: 14 }}>
          {stackGroups.map((g) => (
            <div key={g.title} style={previewStackCard}>
              <div style={previewStackTitle}>{g.title}</div>
              <div style={previewStackItems}>
                {g.items.map((item) => (
                  <span key={item} style={previewStackChip}>
                    {item}
                  </span>
                ))}
              </div>
              <div style={previewStackNote}>{g.note}</div>
            </div>
          ))}
        </div>
      </article>
    ),
  },

  {
    path: 'about/now.md',
    label: 'now.md',
    kind: 'md',
    raw: `# now

> Live · Riga · since 2024

${timeline[0].role} at ${timeline[0].where}.
${timeline[0].note}

## throughline (constant since ${throughline.since.split(' · ')[0]})
- ${throughline.delivered}
- ${throughline.role}`,
    preview: () => (
      <article style={previewProse}>
        <h1 style={previewH1}>Now</h1>
        <p style={previewLede}>
          <span style={previewPulse} /> Live · Riga · since 2024
        </p>

        <div style={previewNowCard}>
          <div style={previewNowTitle}>{timeline[0].role}</div>
          <div style={previewNowWhere}>{timeline[0].where}</div>
          <p style={{ marginTop: 8 }}>{timeline[0].note}</p>
        </div>

        <h2 style={previewH2}>Throughline</h2>
        <p style={{ color: 'var(--ide-fg-muted)', marginBottom: 8 }}>
          Constant since {throughline.since.split(' · ')[0]}.
        </p>
        <ul style={previewList}>
          <li>
            <span style={previewBullet}>›</span>
            {throughline.delivered}
          </li>
          <li>
            <span style={previewBullet}>›</span>
            {throughline.role}
          </li>
        </ul>
      </article>
    ),
  },
];

// === markdown / JSON syntax highlighting =========================
// Lightweight: line-by-line for markdown, char-class spans for JSON.

function highlightMarkdownLine(line: string, key: number): React.ReactElement {
  if (/^#{1,3}\s/.test(line)) {
    return (
      <span key={key} style={{ color: 'var(--ide-magenta)' }}>
        {line}
      </span>
    );
  }
  if (line.startsWith('> ')) {
    return (
      <span key={key} style={{ color: 'var(--ide-comment)', fontStyle: 'italic' }}>
        {line}
      </span>
    );
  }
  if (/^\d+\.\s/.test(line)) {
    const m = line.match(/^(\d+\.\s)(.*)$/)!;
    return (
      <span key={key}>
        <span style={{ color: 'var(--ide-accent)' }}>{m[1]}</span>
        {m[2]}
      </span>
    );
  }
  if (line.startsWith('- ')) {
    return (
      <span key={key}>
        <span style={{ color: 'var(--ide-accent)' }}>-</span>
        {line.slice(1)}
      </span>
    );
  }
  return <span key={key}>{line}</span>;
}

function highlightJson(src: string): React.ReactElement[] {
  // tokens: strings, keys, numbers, true/false/null, punctuation, whitespace
  const tokens: { value: string; type: 'string' | 'key' | 'num' | 'const' | 'punct' | 'space' }[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      tokens.push({ value: src.slice(i, j), type: 'space' });
      i = j;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j += 2;
        else j++;
      }
      j = Math.min(j + 1, src.length);
      // Look ahead to see if this is a key (followed by colon)
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      const isKey = src[k] === ':';
      tokens.push({ value: src.slice(i, j), type: isKey ? 'key' : 'string' });
      i = j;
    } else if (/[-\d]/.test(ch)) {
      let j = i;
      while (j < src.length && /[-\d.eE+]/.test(src[j])) j++;
      tokens.push({ value: src.slice(i, j), type: 'num' });
      i = j;
    } else if (/[a-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-z]/.test(src[j])) j++;
      tokens.push({ value: src.slice(i, j), type: 'const' });
      i = j;
    } else {
      tokens.push({ value: ch, type: 'punct' });
      i++;
    }
  }
  return tokens.map((t, idx) => {
    if (t.type === 'space') return <span key={idx}>{t.value}</span>;
    if (t.type === 'key') return <span key={idx} style={{ color: 'var(--ide-blue)' }}>{t.value}</span>;
    if (t.type === 'string') return <span key={idx} style={{ color: 'var(--ide-string)' }}>{t.value}</span>;
    if (t.type === 'num') return <span key={idx} style={{ color: 'var(--ide-num)' }}>{t.value}</span>;
    if (t.type === 'const') return <span key={idx} style={{ color: 'var(--ide-magenta)' }}>{t.value}</span>;
    return <span key={idx} style={{ color: 'var(--ide-punct)' }}>{t.value}</span>;
  });
}

// === main component ==============================================

type Mode = 'preview' | 'source';

export function IdeOverlay() {
  const [open, setOpen] = useState(false);
  const [activePath, setActivePath] = useState<string>(FILES[0].path);
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [openTabs, setOpenTabs] = useState<string[]>([FILES[0].path]);
  const [clock, setClock] = useState('');
  const overlayRef = useRef<HTMLDivElement>(null);

  // Tick clock
  useEffect(() => {
    if (!open) return;
    const tick = () => {
      const d = new Date();
      const cetOffsetH = 1; // assumes CET (UTC+1) for display; close enough for an easter egg
      const local = new Date(d.getTime() + (cetOffsetH * 60 + d.getTimezoneOffset()) * 60 * 1000);
      setClock(local.toTimeString().slice(0, 8));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [open]);

  // Subscribe to bus
  useEffect(() => {
    const offOpen = onIdeOpen(() => {
      setOpen(true);
      // ensure README is in the tabs
      setOpenTabs((t) => (t.includes('README.md') ? t : ['README.md', ...t]));
      setActivePath('README.md');
    });
    const offClose = onIdeClose(() => setOpen(false));
    return () => { offOpen(); offClose(); };
  }, []);

  // Esc + Cmd/Ctrl+W close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w' && !e.shiftKey) {
        e.preventDefault();
        // close active tab if more than one; otherwise close overlay
        setOpenTabs((tabs) => {
          if (tabs.length <= 1) {
            setOpen(false);
            return tabs;
          }
          const idx = tabs.indexOf(activePath);
          const next = tabs.filter((p) => p !== activePath);
          const newActive = next[Math.max(0, idx - 1)] ?? next[0];
          setActivePath(newActive);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, activePath]);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const openFile = useCallback((path: string) => {
    setOpenTabs((t) => (t.includes(path) ? t : [...t, path]));
    setActivePath(path);
  }, []);

  const closeTab = useCallback((path: string) => {
    setOpenTabs((tabs) => {
      if (tabs.length <= 1) {
        setOpen(false);
        return tabs;
      }
      const idx = tabs.indexOf(path);
      const next = tabs.filter((p) => p !== path);
      if (path === activePath) {
        const newActive = next[Math.max(0, idx - 1)] ?? next[0];
        setActivePath(newActive);
      }
      return next;
    });
  }, [activePath]);

  const activeFile = useMemo(() => FILES.find((f) => f.path === activePath) ?? FILES[0], [activePath]);
  const activeMode = modes[activePath] ?? 'preview';
  const setMode = (m: Mode) => setModes((mm) => ({ ...mm, [activePath]: m }));

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="ide-shell"
      role="dialog"
      aria-label="Open Design IDE"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: ideCss }} />
      <div className="ide-window" onMouseDown={(e) => e.stopPropagation()}>
        {/* Title bar */}
        <div className="ide-titlebar">
          <button
            type="button"
            className="ide-traffic"
            onClick={() => setOpen(false)}
            aria-label="close"
          >
            <span className="lt red" />
            <span className="lt yellow" />
            <span className="lt green" />
          </button>
          <div className="ide-title">
            <span className="ide-title-icon">⊞</span> arthur-buikis ·{' '}
            <span className="ide-title-app">zed</span>
            <span className="ide-title-sep">/</span>
            <span className="ide-title-path">{activePath}</span>
          </div>
          <div className="ide-titlebar-meta">
            <span className="ide-pulse" />
            <span>{clock || '··:··:··'} CET</span>
          </div>
        </div>

        <div className="ide-body">
          {/* File tree */}
          <aside className="ide-sidebar">
            <div className="ide-sidebar-head">PROJECT</div>
            <div className="ide-tree">
              <div className="ide-folder">▾ arthur-buikis</div>
              <div className="ide-tree-children">
                {FILES.filter((f) => !f.path.includes('/')).map((f) => (
                  <FileTreeItem
                    key={f.path}
                    file={f}
                    active={f.path === activePath}
                    onClick={() => openFile(f.path)}
                  />
                ))}
                <div className="ide-folder ide-folder-nested">▾ about</div>
                <div className="ide-tree-children ide-tree-nested-children">
                  {FILES.filter((f) => f.path.startsWith('about/')).map((f) => (
                    <FileTreeItem
                      key={f.path}
                      file={f}
                      active={f.path === activePath}
                      onClick={() => openFile(f.path)}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="ide-sidebar-foot">
              <div>OUTLINE</div>
              <div className="ide-outline">
                <span>▾</span> identity
              </div>
              <div className="ide-outline">
                <span>▾</span> now
              </div>
              <div className="ide-outline">
                <span>▾</span> contact
              </div>
            </div>
          </aside>

          <main className="ide-main">
            <div className="ide-tabbar">
              {openTabs.map((path) => {
                const f = FILES.find((x) => x.path === path)!;
                return (
                  <div
                    key={path}
                    className={`ide-tab ${path === activePath ? 'active' : ''}`}
                    onClick={() => setActivePath(path)}
                  >
                    <FileIcon kind={f.kind} />
                    <span>{f.label}</span>
                    <button
                      type="button"
                      className="ide-tab-close"
                      onClick={(e) => { e.stopPropagation(); closeTab(path); }}
                      aria-label="close tab"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <div className="ide-tab-spacer" />
              <div className="ide-mode-toggle" role="tablist" aria-label="view mode">
                <button
                  type="button"
                  className={activeMode === 'preview' ? 'on' : ''}
                  onClick={() => setMode('preview')}
                  role="tab"
                  aria-selected={activeMode === 'preview'}
                >
                  preview
                </button>
                <button
                  type="button"
                  className={activeMode === 'source' ? 'on' : ''}
                  onClick={() => setMode('source')}
                  role="tab"
                  aria-selected={activeMode === 'source'}
                >
                  source
                </button>
              </div>
            </div>

            <div className="ide-editor">
              {activeMode === 'preview' ? (
                <div className="ide-preview">{activeFile.preview()}</div>
              ) : (
                <SourceView file={activeFile} />
              )}
            </div>

            <div className="ide-statusbar">
              <span>⎇ master</span>
              <span className="ide-status-sep">·</span>
              <span>UTF-8</span>
              <span className="ide-status-sep">·</span>
              <span>{activeFile.kind === 'md' ? 'Markdown' : 'JSON'}</span>
              <span className="ide-status-sep">·</span>
              <span>{activeMode === 'preview' ? 'PREVIEW' : 'SOURCE'}</span>
              <span className="ide-status-spacer" />
              <span>esc to close</span>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function FileTreeItem({ file, active, onClick }: { file: IdeFile; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`ide-tree-item ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      <FileIcon kind={file.kind} />
      <span>{file.label}</span>
    </button>
  );
}

function FileIcon({ kind }: { kind: FileKind }) {
  if (kind === 'json') return <span className="ide-file-ic ide-file-ic-json">{}</span>;
  return <span className="ide-file-ic ide-file-ic-md">M↓</span>;
}

function SourceView({ file }: { file: IdeFile }) {
  const lines = file.raw.split('\n');
  return (
    <div className="ide-source">
      <div className="ide-gutter">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="ide-source-pre">
        {file.kind === 'md'
          ? lines.map((line, i) => (
              <div key={i} className="ide-source-line">
                {highlightMarkdownLine(line || ' ', i)}
              </div>
            ))
          : highlightJson(file.raw)}
      </pre>
    </div>
  );
}

// === inline preview styles (kept as objects so we don't fight the
// global `* { border-radius: 0 !important }` rule via CSS class overrides
// where possible — anything that truly needs rounding goes through the
// scoped <style> block below with !important)
// ================================================================

const previewProse: CSSProperties = {
  fontFamily: 'var(--ide-display)',
  fontSize: 15,
  lineHeight: 1.65,
  color: 'var(--ide-fg)',
  padding: '32px 48px',
  maxWidth: 760,
};
const previewH1: CSSProperties = {
  fontFamily: 'var(--ide-display)',
  fontSize: 48,
  lineHeight: 1,
  letterSpacing: '-0.03em',
  fontWeight: 400,
  marginBottom: 6,
  color: 'var(--ide-fg)',
};
const previewLede: CSSProperties = {
  fontFamily: 'var(--ide-mono)',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: 'var(--ide-fg-muted)',
  marginBottom: 22,
};
const previewH2: CSSProperties = {
  fontFamily: 'var(--ide-display)',
  fontSize: 22,
  letterSpacing: '-0.01em',
  fontWeight: 400,
  margin: '20px 0 8px',
  color: 'var(--ide-fg)',
};
const previewList: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: '0 0 18px',
  display: 'grid',
  gap: 4,
};
const previewBullet: CSSProperties = {
  color: 'var(--ide-accent)',
  marginRight: 8,
  fontFamily: 'var(--ide-mono)',
};
const previewQuote: CSSProperties = {
  borderLeft: '2px solid var(--ide-accent)',
  padding: '8px 16px',
  margin: '24px 0',
  fontStyle: 'italic',
  color: 'var(--ide-fg-muted)',
  fontSize: 17,
  lineHeight: 1.4,
};
const previewRule: CSSProperties = {
  border: 'none',
  borderTop: '1px solid var(--ide-line)',
  margin: '28px 0 22px',
};
const previewKVList: CSSProperties = { display: 'grid', gap: 4, margin: 0 };
const previewKVRow: CSSProperties = { display: 'grid', gridTemplateColumns: '160px 1fr', alignItems: 'baseline' };
const previewKVKey: CSSProperties = { fontFamily: 'var(--ide-mono)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--ide-fg-muted)' };
const previewKVValue: CSSProperties = { fontFamily: 'var(--ide-mono)', fontSize: 13, color: 'var(--ide-fg)', margin: 0 };
const previewOl: CSSProperties = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 };
const previewOlItem: CSSProperties = { display: 'grid', gridTemplateColumns: '34px 1fr', gap: 12, alignItems: 'baseline' };
const previewOlNum: CSSProperties = { fontFamily: 'var(--ide-mono)', fontSize: 12, color: 'var(--ide-accent)', letterSpacing: '0.06em' };
const previewStackCard: CSSProperties = { padding: '14px 16px', background: 'var(--ide-panel-hi)', border: '1px solid var(--ide-line)' };
const previewStackTitle: CSSProperties = { fontFamily: 'var(--ide-mono)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--ide-accent)', marginBottom: 8 };
const previewStackItems: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 };
const previewStackChip: CSSProperties = { fontFamily: 'var(--ide-mono)', fontSize: 11.5, padding: '2px 8px', border: '1px solid var(--ide-line-strong)', color: 'var(--ide-fg)' };
const previewStackNote: CSSProperties = { fontFamily: 'var(--ide-display)', fontStyle: 'italic', fontSize: 13, color: 'var(--ide-fg-muted)' };
const previewPulse: CSSProperties = { display: 'inline-block', width: 8, height: 8, background: 'var(--ide-green)', marginRight: 8, animation: 'ide-pulse 1.6s ease-in-out infinite', verticalAlign: 'middle' };
const previewNowCard: CSSProperties = { padding: 16, background: 'var(--ide-panel-hi)', borderLeft: '3px solid var(--ide-accent)', margin: '16px 0' };
const previewNowTitle: CSSProperties = { fontFamily: 'var(--ide-display)', fontSize: 20, marginBottom: 2 };
const previewNowWhere: CSSProperties = { fontFamily: 'var(--ide-mono)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--ide-fg-muted)' };

// === IDE chrome CSS (scoped under `.ide-shell`) ==================
// Kept as a string so we can override the global border-radius:0 rule
// on the few elements that actually need rounding (the traffic lights).

const ideCss = `
.ide-shell {
  position: fixed;
  inset: 0;
  background: rgba(8, 10, 14, 0.78);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  z-index: 9999;
  display: grid;
  place-items: center;
  padding: 28px;
  --ide-bg:         #14171f;
  --ide-panel:     #181c25;
  --ide-panel-hi:  #1d2230;
  --ide-line:      #262c3a;
  --ide-line-strong: #353c4e;
  --ide-fg:        #d3d8e2;
  --ide-fg-muted:  #7f8699;
  --ide-accent:    #ffb84d;
  --ide-blue:      #79b8ff;
  --ide-magenta:   #c586c0;
  --ide-green:     #6fc36f;
  --ide-red:       #d96666;
  --ide-string:    #b5cea8;
  --ide-num:       #d19a66;
  --ide-comment:   #8b949e;
  --ide-punct:     #c9d1d9;
  --ide-mono:      'Fira Code', ui-monospace, 'JetBrains Mono', Menlo, monospace;
  --ide-display:   'Iowan Old Style', 'Times New Roman', Georgia, serif;
}
.ide-window {
  width: min(1400px, calc(100vw - 56px));
  height: min(900px, calc(100vh - 56px));
  background: var(--ide-bg);
  color: var(--ide-fg);
  font-family: var(--ide-mono);
  display: grid;
  grid-template-rows: 36px 1fr;
  border: 1px solid var(--ide-line);
  box-shadow: 0 30px 80px rgba(0,0,0,0.55);
  overflow: hidden;
}
.ide-titlebar {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 16px;
  padding: 0 14px;
  background: var(--ide-panel);
  border-bottom: 1px solid var(--ide-line);
  font-size: 12px;
}
.ide-traffic { display: inline-flex; gap: 8px; padding: 4px 0; background: transparent; border: none; cursor: pointer; }
.ide-traffic .lt { width: 12px; height: 12px; border-radius: 999px !important; display: inline-block; }
.ide-traffic .lt.red    { background: #ff5f56; }
.ide-traffic .lt.yellow { background: #ffbd2e; }
.ide-traffic .lt.green  { background: #27c93f; }
.ide-title { color: var(--ide-fg-muted); text-align: center; font-size: 11.5px; letter-spacing: 0.02em; }
.ide-title-icon { color: var(--ide-accent); margin-right: 4px; }
.ide-title-app { color: var(--ide-fg); }
.ide-title-sep { color: var(--ide-line-strong); margin: 0 8px; }
.ide-title-path { color: var(--ide-fg); }
.ide-titlebar-meta { display: inline-flex; gap: 8px; align-items: center; color: var(--ide-fg-muted); font-size: 10.5px; letter-spacing: 0.06em; }
.ide-pulse { width: 7px; height: 7px; border-radius: 999px !important; background: var(--ide-green); animation: ide-pulse 1.6s ease-in-out infinite; }
@keyframes ide-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .ide-pulse, .ide-shell * { animation: none !important; } }

.ide-body { display: grid; grid-template-columns: 240px 1fr; min-height: 0; }
.ide-sidebar { background: var(--ide-panel); border-right: 1px solid var(--ide-line); overflow-y: auto; display: flex; flex-direction: column; }
.ide-sidebar-head { padding: 10px 14px 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--ide-fg-muted); }
.ide-tree { padding: 0 0 12px; flex: 1; }
.ide-folder { padding: 4px 14px; color: var(--ide-blue); font-size: 12px; cursor: default; }
.ide-folder-nested { padding-left: 28px; color: var(--ide-magenta); }
.ide-tree-children { display: flex; flex-direction: column; }
.ide-tree-nested-children { padding-left: 16px; }
.ide-tree-item {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 4px 14px 4px 28px; background: transparent; border: none;
  font: inherit; color: var(--ide-fg); cursor: pointer; text-align: left;
  border-left: 2px solid transparent;
}
.ide-tree-nested-children .ide-tree-item { padding-left: 36px; }
.ide-tree-item:hover { background: rgba(255,255,255,0.025); }
.ide-tree-item.active { background: var(--ide-panel-hi); border-left-color: var(--ide-accent); color: var(--ide-accent); }
.ide-file-ic { font-family: var(--ide-mono); font-size: 9.5px; letter-spacing: 0.04em; color: var(--ide-fg-muted); display: inline-block; min-width: 18px; text-align: center; }
.ide-file-ic-json { color: var(--ide-magenta); }
.ide-file-ic-md { color: var(--ide-blue); }
.ide-sidebar-foot { border-top: 1px solid var(--ide-line); padding: 10px 14px; font-size: 10.5px; color: var(--ide-fg-muted); display: grid; gap: 4px; }
.ide-sidebar-foot > div:first-child { text-transform: uppercase; letter-spacing: 0.16em; margin-bottom: 4px; }
.ide-outline span { color: var(--ide-accent); margin-right: 6px; }

.ide-main { display: grid; grid-template-rows: 34px 1fr 24px; min-height: 0; }
.ide-tabbar { background: var(--ide-panel); border-bottom: 1px solid var(--ide-line); display: flex; align-items: stretch; overflow: hidden; }
.ide-tab {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 0 16px; height: 100%;
  font-size: 11.5px; color: var(--ide-fg-muted); cursor: pointer;
  border-right: 1px solid var(--ide-line);
  position: relative;
}
.ide-tab.active { background: var(--ide-bg); color: var(--ide-fg); }
.ide-tab.active::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0;
  height: 2px; background: var(--ide-accent);
}
.ide-tab-close {
  background: transparent; border: none; color: var(--ide-fg-muted);
  font-size: 14px; line-height: 1; padding: 0 0 0 4px; cursor: pointer; opacity: 0.6;
}
.ide-tab-close:hover { opacity: 1; color: var(--ide-fg); }
.ide-tab-spacer { flex: 1; border-right: 1px solid var(--ide-line); }
.ide-mode-toggle { display: inline-flex; padding: 5px 8px; gap: 4px; align-items: center; }
.ide-mode-toggle button {
  background: transparent; border: 1px solid var(--ide-line);
  color: var(--ide-fg-muted); font: inherit; font-size: 10.5px;
  text-transform: uppercase; letter-spacing: 0.14em;
  padding: 3px 10px; cursor: pointer;
}
.ide-mode-toggle button:hover { color: var(--ide-fg); border-color: var(--ide-line-strong); }
.ide-mode-toggle button.on { color: var(--ide-bg); background: var(--ide-accent); border-color: var(--ide-accent); }

.ide-editor { overflow: auto; background: var(--ide-bg); }
.ide-preview { color: var(--ide-fg); }
.ide-source { display: grid; grid-template-columns: 48px 1fr; min-height: 100%; }
.ide-gutter { padding: 18px 8px; text-align: right; color: #4d5366; font-size: 11.5px; font-family: var(--ide-mono); line-height: 1.6; user-select: none; background: var(--ide-panel); border-right: 1px solid var(--ide-line); }
.ide-gutter > div { line-height: 1.6; }
.ide-source-pre { padding: 18px 18px 80px 18px; font-family: var(--ide-mono); font-size: 13px; line-height: 1.6; white-space: pre-wrap; color: var(--ide-fg); margin: 0; }
.ide-source-line { white-space: pre-wrap; min-height: 1.6em; }

.ide-statusbar {
  background: var(--ide-panel);
  border-top: 1px solid var(--ide-line);
  display: flex; align-items: center; gap: 8px;
  padding: 0 14px; font-size: 10.5px; color: var(--ide-fg-muted);
}
.ide-status-sep { color: var(--ide-line-strong); }
.ide-status-spacer { flex: 1; }

@media (max-width: 720px) {
  .ide-shell { padding: 0; }
  .ide-window { width: 100vw; height: 100vh; border: none; }
  .ide-body { grid-template-columns: 56px 1fr; }
  .ide-sidebar-head { font-size: 0; }
  .ide-tree-item span:last-child { display: none; }
  .ide-folder { font-size: 0; }
  .ide-folder::after { content: '▾'; font-size: 14px; color: inherit; }
  .ide-sidebar-foot { display: none; }
  .ide-preview > * { padding-inline: 18px !important; }
  .ide-tab { padding: 0 10px; }
}
`;
