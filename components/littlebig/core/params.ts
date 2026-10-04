// Live-tunable parameters. Register in init(), read `.value` every frame (no lookups, no
// allocation). `?p.<key>=<value>` overrides a default at boot; the debug hook (window.__littlebig
// .params) and the F1 overlay set them live.

export interface NumberParam {
  kind: 'number';
  key: string;
  label: string;
  min: number;
  max: number;
  value: number;
  initial: number;
}

export interface ToggleParam {
  kind: 'toggle';
  key: string;
  label: string;
  value: boolean;
  initial: boolean;
}

export type Param = NumberParam | ToggleParam;

export class ParamRegistry {
  readonly list: Param[] = [];
  private readonly byKey = new Map<string, Param>();
  private readonly listeners: Array<(p: Param) => void> = [];
  private readonly overrides = new Map<string, string>();

  constructor(search: string) {
    new URLSearchParams(search).forEach((v, k) => {
      if (k.startsWith('p.')) this.overrides.set(k.slice(2), v);
    });
  }

  number(key: string, spec: { label?: string; min: number; max: number; value: number }): NumberParam {
    const existing = this.byKey.get(key);
    if (existing?.kind === 'number') return existing;
    const o = this.overrides.get(key);
    const value = o !== undefined && Number.isFinite(Number(o)) ? Number(o) : spec.value;
    const p: NumberParam = { kind: 'number', key, label: spec.label ?? key, min: spec.min, max: spec.max, value, initial: spec.value };
    this.add(p);
    return p;
  }

  toggle(key: string, spec: { label?: string; value: boolean }): ToggleParam {
    const existing = this.byKey.get(key);
    if (existing?.kind === 'toggle') return existing;
    const o = this.overrides.get(key);
    const value = o === undefined ? spec.value : o === '1' || o === 'true';
    const p: ToggleParam = { kind: 'toggle', key, label: spec.label ?? key, value, initial: spec.value };
    this.add(p);
    return p;
  }

  get(key: string): Param | undefined {
    return this.byKey.get(key);
  }

  set(key: string, value: number | boolean): boolean {
    const p = this.byKey.get(key);
    if (!p) return false;
    if (p.kind === 'number') p.value = Number(value);
    else p.value = value === true || value === 1 || (value as unknown) === 'true' || (value as unknown) === '1';
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](p);
    return true;
  }

  /** Fires after any set(). Use for params that need a rebuild. Returns an unsubscribe. */
  onChange(fn: (p: Param) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  snapshot(): Record<string, number | boolean> {
    const out: Record<string, number | boolean> = {};
    for (const p of this.list) out[p.key] = p.value;
    return out;
  }

  private add(p: Param) {
    this.list.push(p);
    this.byKey.set(p.key, p);
  }
}
