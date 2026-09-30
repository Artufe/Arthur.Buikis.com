// Live-tunable parameters. Systems register them in init() and read `.value` every frame
// (no lookups, no allocation). The settings overlay builds its controls from this registry,
// and URL query `?p.<key>=<value>` overrides the default at boot.

export interface NumberParam {
  kind: 'number';
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  value: number;
  initial: number;
}

export interface ToggleParam {
  kind: 'toggle';
  key: string;
  label: string;
  group: string;
  value: boolean;
  initial: boolean;
}

export type Param = NumberParam | ToggleParam;

type NumberSpec = { label: string; group: string; min: number; max: number; step?: number; value: number };
type ToggleSpec = { label: string; group: string; value: boolean };

export class ParamRegistry {
  readonly list: Param[] = [];
  private readonly byKey = new Map<string, Param>();
  private readonly listeners: Array<(p: Param) => void> = [];
  private readonly overrides: Map<string, string>;

  constructor(search: string) {
    this.overrides = new Map();
    const q = new URLSearchParams(search);
    q.forEach((v, k) => {
      if (k.startsWith('p.')) this.overrides.set(k.slice(2), v);
    });
  }

  number(key: string, spec: NumberSpec): NumberParam {
    const existing = this.byKey.get(key);
    if (existing?.kind === 'number') return existing;
    const o = this.overrides.get(key);
    const value = o !== undefined && Number.isFinite(Number(o)) ? Number(o) : spec.value;
    const p: NumberParam = {
      kind: 'number',
      key,
      label: spec.label,
      group: spec.group,
      min: spec.min,
      max: spec.max,
      step: spec.step ?? (spec.max - spec.min) / 200,
      value,
      initial: spec.value,
    };
    this.add(p);
    return p;
  }

  toggle(key: string, spec: ToggleSpec): ToggleParam {
    const existing = this.byKey.get(key);
    if (existing?.kind === 'toggle') return existing;
    const o = this.overrides.get(key);
    const value = o === undefined ? spec.value : o === '1' || o === 'true';
    const p: ToggleParam = { kind: 'toggle', key, label: spec.label, group: spec.group, value, initial: spec.value };
    this.add(p);
    return p;
  }

  get(key: string): Param | undefined {
    return this.byKey.get(key);
  }

  set(key: string, value: number | boolean) {
    const p = this.byKey.get(key);
    if (!p) return;
    if (p.kind === 'number') p.value = Number(value);
    else p.value = Boolean(value);
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](p);
  }

  /** Fires after any set() (overlay, debug hook). Use for params that need a rebuild. */
  onChange(fn: (p: Param) => void) {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private add(p: Param) {
    this.list.push(p);
    this.byKey.set(p.key, p);
  }
}
