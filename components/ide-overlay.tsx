'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

// `raw` is the source of truth for both modes:
//   - preview tab: routed through MarkdownPreview (react-markdown + remark-gfm)
//   - source tab: raw text with line-level syntax highlighting
// For non-markdown files (currently just stack.json) `preview` is an
// explicit JSX renderer — JSON isn't markdown so we hand-render it.
type IdeFile = {
  path: string;
  label: string;
  kind: FileKind;
  raw: string;
  preview?: () => React.ReactElement;
};

// === file definitions ============================================
// The markdown strings are written to render well via react-markdown:
//   * GFM tables for key/value lists
//   * `> blockquote` for ledes and pull quotes
//   * Standard ordered/unordered lists
//   * Real autolinks where they matter (email, socials)

const aboutGlanceTable = [
  '| key | value |',
  '|-----|-------|',
  ...atAGlance.map((row) => `| ${row.k} | ${row.v} |`),
].join('\n');

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

## Now

- **${site.bio.jobTitle.toLowerCase()}** · since 2024
- python · rust · kubernetes

## Contact

- email: <${site.email}>
${site.socials.map((s) => `- [${s.label.toLowerCase()} ↗](${s.href})`).join('\n')}

> "The best engineers I've worked with are boring to watch. They delete more than they add."
`,
  },

  {
    path: 'about/about.md',
    label: 'about.md',
    kind: 'md',
    raw: `# About

> Backend & platform engineer · Riga · twelve-ish years in

It began on Upwork in 2015. The first jobs were small — scrapers,
automation, the kind of thing people pay for when their spreadsheet
has finally lost the argument.

Three years in came **strange-logic** — a US domain-intelligence shop.
By the second stint in 2021, the work had grown legs: a
PHP-to-Python rewrite, ClickHouse brought in, and the Expired Domain
Search pipeline that eventually crawled ~700M domains and stored
43 TB across twelve servers.

Side products in parallel. **MyProxy** (2020–22) brought
cost-per-GB down ~20× over its run. **MarkFlow** remains live.

Since 2024 — Riga media-processing platform.
Python + Rust now, virtual tours, Kubernetes plumbing.

Remote-friendly to EU-time teams. Available for the right next
thing only when the current role naturally winds.

---

## At a glance

${aboutGlanceTable}
`,
  },

  {
    path: 'about/beliefs.md',
    label: 'beliefs.md',
    kind: 'md',
    raw: `# Beliefs

About software, mostly.

${beliefs.map((b, i) => `${i + 1}. ${b}`).join('\n')}
`,
  },

  {
    path: 'about/anti-list.md',
    label: 'anti-list.md',
    kind: 'md',
    raw: `# Avoid

In this order.

${antiList.map((a, i) => `${i + 1}. ${a}`).join('\n')}
`,
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
      <article className="ide-md-prose">
        <h1 className="ide-md-h1">Stack</h1>
        <p className="ide-md-lede">On the keyboard this month.</p>
        <div className="ide-stack-cards">
          {stackGroups.map((g) => (
            <div key={g.title} className="ide-stack-card">
              <div className="ide-stack-card-title">{g.title}</div>
              <div className="ide-stack-card-items">
                {g.items.map((item) => (
                  <span key={item} className="ide-stack-chip">
                    {item}
                  </span>
                ))}
              </div>
              <div className="ide-stack-card-note">{g.note}</div>
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
    raw: `# Now

> ● Live · Riga · since 2024

**${timeline[0].role}** — ${timeline[0].where}.

${timeline[0].note}

## Throughline

Constant since ${throughline.since.split(' · ')[0]}.

- ${throughline.delivered}
- ${throughline.role}
`,
  },
];

// === markdown preview ============================================
// One component handles every .md file. Custom component overrides
// keep typography consistent with the rest of the site (serif h1/h2,
// mono micro-type, accent-coloured numerals, etc.) and let GFM tables
// + autolinks render natively.

const mdComponents: Components = {
  h1: ({ children }) => <h1 className="ide-md-h1">{children}</h1>,
  h2: ({ children }) => <h2 className="ide-md-h2">{children}</h2>,
  h3: ({ children }) => <h3 className="ide-md-h3">{children}</h3>,
  p: ({ children }) => <p className="ide-md-p">{children}</p>,
  blockquote: ({ children }) => <blockquote className="ide-md-quote">{children}</blockquote>,
  ul: ({ children }) => <ul className="ide-md-ul">{children}</ul>,
  ol: ({ children }) => <ol className="ide-md-ol">{children}</ol>,
  li: ({ children }) => <li className="ide-md-li">{children}</li>,
  a: ({ href, children }) => (
    <a
      className="ide-md-link"
      href={href}
      target={href?.startsWith('http') ? '_blank' : undefined}
      rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="ide-md-strong">{children}</strong>,
  em: ({ children }) => <em className="ide-md-em">{children}</em>,
  code: ({ children }) => <code className="ide-md-code">{children}</code>,
  pre: ({ children }) => <pre className="ide-md-pre">{children}</pre>,
  hr: () => <hr className="ide-md-hr" />,
  table: ({ children }) => <table className="ide-md-table">{children}</table>,
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => <th className="ide-md-th">{children}</th>,
  td: ({ children }) => <td className="ide-md-td">{children}</td>,
};

function MarkdownPreview({ source }: { source: string }) {
  return (
    <article className="ide-md-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {source}
      </ReactMarkdown>
    </article>
  );
}

// === source-mode syntax highlighting =============================

function highlightMarkdownLine(line: string, key: number): React.ReactElement {
  if (/^#{1,3}\s/.test(line)) {
    return <span key={key} style={{ color: 'var(--ide-magenta)' }}>{line}</span>;
  }
  if (line.startsWith('> ')) {
    return <span key={key} style={{ color: 'var(--ide-comment)', fontStyle: 'italic' }}>{line}</span>;
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
  if (line.startsWith('|') && line.endsWith('|')) {
    return <span key={key} style={{ color: 'var(--ide-blue)' }}>{line}</span>;
  }
  return <span key={key}>{line}</span>;
}

function highlightJson(src: string): React.ReactElement[] {
  type Tok = { value: string; type: 'string' | 'key' | 'num' | 'const' | 'punct' | 'space' };
  const tokens: Tok[] = [];
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
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const offOpen = onIdeOpen(() => {
      setOpen(true);
      setOpenTabs((t) => (t.includes('README.md') ? t : ['README.md', ...t]));
      setActivePath('README.md');
    });
    const offClose = onIdeClose(() => setOpen(false));
    return () => { offOpen(); offClose(); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w' && !e.shiftKey) {
        e.preventDefault();
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
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ide-cta ide-cta--exit"
              aria-label="Return to the rendered site"
            >
              <span className="ide-cta__dot" aria-hidden />
              <span className="ide-cta__icon" aria-hidden>{'«/'}</span>
              <span className="ide-cta__label">return to html</span>
            </button>
          </div>
        </div>

        <div className="ide-body">
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
              <div className="ide-outline"><span>▾</span> identity</div>
              <div className="ide-outline"><span>▾</span> now</div>
              <div className="ide-outline"><span>▾</span> contact</div>
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
                <div className="ide-preview">
                  {activeFile.kind === 'md' ? (
                    <MarkdownPreview source={activeFile.raw} />
                  ) : (
                    activeFile.preview?.()
                  )}
                </div>
              ) : (
                <SourceView file={activeFile} />
              )}
            </div>

            <div className="ide-statusbar">
              <span>⎇ master</span>
              <span className="ide-status-sep">·</span>
              <span>UTF-8</span>
              <span className="ide-status-sep">·</span>
              <span>{activeFile.kind === 'md' ? 'Markdown · GFM' : 'JSON'}</span>
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

// === IDE chrome CSS (scoped under `.ide-shell`) ==================
// Extends the original chrome with markdown-prose typography rules so
// the react-markdown output uses the same tokens as the rest of the IDE
// (serif headings, mono micro-type, accent-coloured numerals).

const ideCss = `
.ide-shell {
  position: fixed;
  inset: 0;
  background: #0a0c11;
  z-index: 9999;
  display: block;
  padding: 0;
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
  width: 100vw;
  height: 100vh;
  background: var(--ide-bg);
  color: var(--ide-fg);
  font-family: var(--ide-mono);
  display: grid;
  grid-template-rows: 38px 1fr;
  border: 0;
  box-shadow: none;
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
/* Force the .ide-cta exit button visible inside the overlay regardless of
   viewport — the IDE is full-screen, the user must always have a way out. */
.ide-shell .ide-cta { display: inline-flex; }
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

/* ---- markdown prose ----------------------------------------- */
.ide-md-prose { padding: 32px 48px 64px; max-width: 760px; font-family: var(--ide-display); font-size: 15px; line-height: 1.65; color: var(--ide-fg); }
.ide-md-h1 { font-family: var(--ide-display); font-size: 48px; line-height: 1; letter-spacing: -0.03em; font-weight: 400; margin: 0 0 6px; }
.ide-md-h2 { font-family: var(--ide-display); font-size: 24px; letter-spacing: -0.01em; font-weight: 400; margin: 28px 0 10px; }
.ide-md-h3 { font-family: var(--ide-display); font-size: 18px; letter-spacing: -0.005em; font-weight: 400; margin: 20px 0 6px; }
.ide-md-lede {
  font-family: var(--ide-mono); font-size: 12px;
  text-transform: uppercase; letter-spacing: 0.12em;
  color: var(--ide-fg-muted); margin-bottom: 22px;
}
.ide-md-p { margin: 0 0 14px; }
.ide-md-p:last-child { margin-bottom: 0; }
.ide-md-quote {
  border-left: 2px solid var(--ide-accent);
  padding: 6px 16px;
  margin: 18px 0;
  font-family: var(--ide-mono);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--ide-fg-muted);
}
.ide-md-quote .ide-md-p { margin: 0; font: inherit; color: inherit; }
.ide-md-ul, .ide-md-ol { padding-left: 0; margin: 4px 0 18px; list-style: none; }
.ide-md-li { padding-left: 22px; position: relative; margin: 4px 0; }
.ide-md-ul .ide-md-li::before {
  content: '›'; position: absolute; left: 0; top: 0;
  color: var(--ide-accent);
  font-family: var(--ide-mono);
}
.ide-md-ol { counter-reset: ide-ol; }
.ide-md-ol .ide-md-li { padding-left: 36px; counter-increment: ide-ol; }
.ide-md-ol .ide-md-li::before {
  content: counter(ide-ol, decimal-leading-zero);
  position: absolute; left: 0; top: 1px;
  font-family: var(--ide-mono); font-size: 12px;
  color: var(--ide-accent); letter-spacing: 0.06em;
}
.ide-md-link { color: var(--ide-blue); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--ide-blue) 35%, transparent); }
.ide-md-link:hover { color: var(--ide-accent); border-bottom-color: var(--ide-accent); }
.ide-md-strong { font-family: var(--ide-display); font-weight: 600; color: var(--ide-fg); }
.ide-md-em { font-style: italic; color: var(--ide-fg-muted); }
.ide-md-code {
  font-family: var(--ide-mono); font-size: 12.5px;
  padding: 1px 6px;
  background: var(--ide-panel-hi);
  border: 1px solid var(--ide-line);
  color: var(--ide-string);
}
.ide-md-pre {
  font-family: var(--ide-mono); font-size: 12.5px;
  padding: 12px 14px;
  background: var(--ide-panel);
  border: 1px solid var(--ide-line);
  border-left: 2px solid var(--ide-accent);
  overflow-x: auto;
  margin: 14px 0;
}
.ide-md-pre code { background: transparent; border: 0; padding: 0; color: var(--ide-fg); }
.ide-md-hr { border: 0; border-top: 1px solid var(--ide-line); margin: 28px 0 22px; }
.ide-md-table {
  border-collapse: collapse;
  margin: 4px 0 18px;
  font-family: var(--ide-mono); font-size: 12.5px;
  width: 100%;
}
.ide-md-th, .ide-md-td {
  padding: 7px 12px;
  border: 1px solid var(--ide-line);
  text-align: left;
  vertical-align: top;
}
.ide-md-th {
  background: var(--ide-panel);
  color: var(--ide-fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 10px;
  font-weight: 400;
}

/* the "lede" used to be a paragraph immediately after h1; on .md preview we
   instead render quote-as-lede above. but the stack.json hand-render still uses
   .ide-md-lede so keep the class above + the variant below for chip groups */

.ide-stack-cards { display: grid; gap: 14px; }
.ide-stack-card { padding: 14px 16px; background: var(--ide-panel-hi); border: 1px solid var(--ide-line); }
.ide-stack-card-title { font-family: var(--ide-mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.16em; color: var(--ide-accent); margin-bottom: 8px; }
.ide-stack-card-items { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.ide-stack-chip { font-family: var(--ide-mono); font-size: 11.5px; padding: 2px 8px; border: 1px solid var(--ide-line-strong); color: var(--ide-fg); }
.ide-stack-card-note { font-family: var(--ide-display); font-style: italic; font-size: 13px; color: var(--ide-fg-muted); }

@media (max-width: 720px) {
  .ide-shell { padding: 0; }
  .ide-window { width: 100vw; height: 100vh; border: none; }
  .ide-body { grid-template-columns: 56px 1fr; }
  .ide-sidebar-head { font-size: 0; }
  .ide-tree-item span:last-child { display: none; }
  .ide-folder { font-size: 0; }
  .ide-folder::after { content: '▾'; font-size: 14px; color: inherit; }
  .ide-sidebar-foot { display: none; }
  .ide-md-prose { padding: 24px 18px 48px; }
  .ide-tab { padding: 0 10px; }
}
`;
