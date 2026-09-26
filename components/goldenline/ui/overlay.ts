// Settings + performance overlay (F1 or backtick). Hidden by default. Built once from the
// param registry; text refreshes at 4 Hz and the frame graph at 15 Hz, so nothing here
// allocates per frame. Controls for params registered after boot appear on the next open.

import type { GLContext, Quality } from '../core/contracts';
import type { Param } from '../core/params';

export interface Overlay {
  update(now: number): void;
  dispose(): void;
}

const GRAPH_W = 300;
const GRAPH_H = 72;
const GRAPH_MAX_MS = 50;

export function createOverlay(ctx: GLContext, host: HTMLElement, setQuality: (q: Quality) => void): Overlay {
  const root = document.createElement('div');
  root.setAttribute('data-goldenline-overlay', '');
  root.style.cssText =
    'position:absolute;top:10px;right:10px;z-index:5;width:330px;max-height:calc(100% - 20px);overflow:auto;' +
    'padding:10px 12px;background:rgba(12,10,8,0.82);color:#f2e6d4;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'border:1px solid rgba(255,184,77,0.35);backdrop-filter:blur(6px);display:none;user-select:none;';
  root.addEventListener('mousedown', (e) => e.stopPropagation());
  root.addEventListener('wheel', (e) => e.stopPropagation());

  const title = document.createElement('div');
  title.textContent = 'GOLDENLINE · settings  (F1)';
  title.style.cssText = 'letter-spacing:0.18em;color:#ffb84d;margin-bottom:6px;';
  const stats = document.createElement('pre');
  stats.style.cssText = 'margin:0 0 6px;white-space:pre;font:inherit;';
  const graph = document.createElement('canvas');
  graph.width = GRAPH_W;
  graph.height = GRAPH_H;
  graph.style.cssText = `width:${GRAPH_W}px;height:${GRAPH_H}px;display:block;background:rgba(0,0,0,0.35);margin-bottom:8px;`;
  const g2d = graph.getContext('2d') as CanvasRenderingContext2D;

  const qualityRow = document.createElement('label');
  qualityRow.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:8px;';
  qualityRow.textContent = 'quality preset';
  const qualitySel = document.createElement('select');
  for (const q of ['low', 'medium', 'high', 'ultra'] as Quality[]) {
    const o = document.createElement('option');
    o.value = q;
    o.textContent = q;
    qualitySel.appendChild(o);
  }
  qualitySel.value = ctx.quality;
  qualitySel.style.cssText = 'background:#1c1712;color:inherit;border:1px solid #5a4a36;font:inherit;';
  qualitySel.addEventListener('change', () => setQuality(qualitySel.value as Quality));
  qualityRow.appendChild(qualitySel);

  const controls = document.createElement('div');
  root.append(title, stats, graph, qualityRow, controls);
  host.appendChild(root);

  let builtFor = -1;
  const inputs = new Map<string, HTMLInputElement>();
  const valueLabels = new Map<string, HTMLSpanElement>();

  const buildControls = () => {
    if (builtFor === ctx.params.list.length) return;
    builtFor = ctx.params.list.length;
    controls.textContent = '';
    inputs.clear();
    valueLabels.clear();
    const groups = new Map<string, Param[]>();
    for (const p of ctx.params.list) {
      const arr = groups.get(p.group) ?? [];
      arr.push(p);
      groups.set(p.group, arr);
    }
    for (const [group, list] of groups) {
      const det = document.createElement('details');
      det.open = group === 'core' || group === 'post';
      const sum = document.createElement('summary');
      sum.textContent = group;
      sum.style.cssText = 'cursor:pointer;color:#ffb84d;margin:4px 0;';
      det.appendChild(sum);
      for (const p of list) {
        const row = document.createElement('label');
        row.style.cssText = 'display:grid;grid-template-columns:1fr 120px 44px;gap:6px;align-items:center;margin:2px 0;';
        const name = document.createElement('span');
        name.textContent = p.label;
        const input = document.createElement('input');
        const val = document.createElement('span');
        val.style.cssText = 'text-align:right;opacity:0.8;';
        if (p.kind === 'number') {
          input.type = 'range';
          input.min = String(p.min);
          input.max = String(p.max);
          input.step = String(p.step);
          input.value = String(p.value);
          val.textContent = fmt(p.value);
          input.addEventListener('input', () => {
            ctx.params.set(p.key, Number(input.value));
            val.textContent = fmt(Number(input.value));
          });
        } else {
          input.type = 'checkbox';
          input.checked = p.value;
          input.style.justifySelf = 'start';
          input.addEventListener('change', () => ctx.params.set(p.key, input.checked));
        }
        input.style.accentColor = '#ffb84d';
        row.append(name, input, val);
        det.appendChild(row);
        inputs.set(p.key, input);
        valueLabels.set(p.key, val);
      }
      controls.appendChild(det);
    }
  };

  let visible = false;
  const setVisible = (v: boolean) => {
    visible = v;
    root.style.display = v ? 'block' : 'none';
    if (v) {
      buildControls();
      for (const p of ctx.params.list) {
        const el = inputs.get(p.key);
        if (!el) continue;
        if (p.kind === 'number') {
          el.value = String(p.value);
          const l = valueLabels.get(p.key);
          if (l) l.textContent = fmt(p.value);
        } else el.checked = p.value;
      }
      if (document.pointerLockElement) document.exitPointerLock();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'F1' || e.code === 'Backquote') {
      e.preventDefault();
      setVisible(!visible);
    }
  };
  window.addEventListener('keydown', onKey);

  let lastText = 0;
  let lastGraph = 0;
  const systemNames = Object.keys(ctx.perf.systemMs);

  const drawGraph = () => {
    const perf = ctx.perf;
    const s = perf.summary;
    g2d.clearRect(0, 0, GRAPH_W, GRAPH_H);
    const n = Math.min(perf.count, GRAPH_W);
    const yOf = (ms: number) => GRAPH_H - Math.min(1, ms / GRAPH_MAX_MS) * GRAPH_H;
    g2d.fillStyle = 'rgba(255,184,77,0.85)';
    for (let i = 0; i < n; i++) {
      const idx = (perf.head - n + i + perf.frames.length) % perf.frames.length;
      const ms = perf.frames[idx];
      const y = yOf(ms);
      g2d.fillStyle = ms > s.median + 4 ? 'rgba(255,90,70,0.95)' : 'rgba(255,184,77,0.8)';
      g2d.fillRect(GRAPH_W - n + i, y, 1, GRAPH_H - y);
    }
    g2d.fillStyle = 'rgba(255,255,255,0.35)';
    g2d.fillRect(0, yOf(1000 / 90), GRAPH_W, 1); // 90 FPS
    g2d.fillStyle = 'rgba(120,200,255,0.5)';
    g2d.fillRect(0, yOf(1000 / 60), GRAPH_W, 1); // 60 FPS
    g2d.fillStyle = 'rgba(255,90,70,0.6)';
    g2d.fillRect(0, yOf(s.median + 4), GRAPH_W, 1); // hitch line
  };

  return {
    update(now) {
      if (!visible) return;
      if (now - lastGraph > 66) {
        lastGraph = now;
        drawGraph();
      }
      if (now - lastText < 250) return;
      lastText = now;
      const s = ctx.perf.summarize();
      const info = ctx.renderer.info.render as unknown as { drawCalls?: number; calls?: number; triangles: number };
      let text =
        `fps ${s.fps.toFixed(0).padStart(4)}   median ${s.median.toFixed(1)} ms\n` +
        `1% low ${s.low1.toFixed(0).padStart(3)} fps (${s.p99.toFixed(1)} ms)   max ${s.max.toFixed(1)}\n` +
        `hitches >med+4ms: ${s.hitches}\n` +
        `draws ${info.drawCalls ?? info.calls ?? 0}   tris ${(info.triangles / 1e6).toFixed(2)}M   ` +
        `${ctx.canvas.width}×${ctx.canvas.height}\n` +
        'cpu ms: ';
      for (let i = 0; i < systemNames.length; i++) {
        const k = systemNames[i];
        text += `${k} ${ctx.perf.systemMs[k].toFixed(2)}${i % 3 === 2 ? '\n        ' : '  '}`;
      }
      const gpuKeys = Object.keys(ctx.perf.gpuMs);
      if (gpuKeys.length) {
        text += '\ngpu ms: ';
        for (const k of gpuKeys) text += `${k} ${ctx.perf.gpuMs[k].toFixed(2)}  `;
      }
      stats.textContent = text;
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}

function fmt(v: number) {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}
