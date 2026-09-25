export type SoundTheme = 'light' | 'dark';
export type OneShot = 'eat' | 'golden' | 'death' | 'sink' | 'ui';
type LoopName = 'wind-light' | 'wind-night' | 'slither';
type ClipName = OneShot | LoopName;

export const SOUND_KEY = 'snake.sound';

const CLIPS: ClipName[] = ['wind-light', 'wind-night', 'slither', 'eat', 'golden', 'death', 'sink', 'ui'];
const LOOPS: LoopName[] = ['wind-light', 'wind-night', 'slither'];

/** First and last audible sample indices (end exclusive). MP3 encoders pad both ends with silence. */
export function silenceBounds(data: Float32Array, threshold = 1e-3): { start: number; end: number } {
  let start = 0;
  while (start < data.length && Math.abs(data[start]) < threshold) start++;
  let end = data.length;
  while (end > start && Math.abs(data[end - 1]) < threshold) end--;
  return start >= end ? { start: 0, end: data.length } : { start, end };
}

export function comboRate(combo: number): number {
  return 1 + Math.min(0.3, Math.max(0, combo - 1) * 0.06);
}

export function slitherMix(speed: number, moving: boolean): { gain: number; rate: number } {
  if (!moving) return { gain: 0, rate: 1 };
  const t = Math.min(1, Math.max(0, (speed - 5) / 6));
  return { gain: 0.22 + 0.3 * t, rate: 0.92 + 0.28 * t };
}

type Loop = { src: AudioBufferSourceNode; gain: GainNode };

export class SnakeSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambience: GainNode | null = null;
  private movement: GainNode | null = null;
  private effects: GainNode | null = null;
  private buffers = new Map<ClipName, AudioBuffer>();
  private loading: Promise<void> | null = null;
  private loops = new Map<LoopName, Loop>();
  private muted = true;
  private suspended = false;
  private theme: SoundTheme;

  constructor(theme: SoundTheme, private readonly base = '/snake/sfx/') {
    this.theme = theme;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Call from a user-gesture handler: browsers only let audio start there. */
  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    if (muted) {
      this.ramp(this.master, 0);
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (!this.suspended) await ctx.resume().catch(() => {});
    await this.load();
    if (this.muted) return;
    this.startLoops();
    this.ramp(this.master, 1);
  }

  setTheme(theme: SoundTheme): void {
    this.theme = theme;
    this.ramp(this.loops.get('wind-light')?.gain, theme === 'light' ? 1 : 0, 1);
    this.ramp(this.loops.get('wind-night')?.gain, theme === 'dark' ? 1 : 0, 1);
  }

  setMotion(speed: number, moving: boolean): void {
    const loop = this.loops.get('slither');
    if (!loop || !this.ctx) return;
    const mix = slitherMix(speed, moving);
    this.ramp(loop.gain, mix.gain, 0.15);
    loop.src.playbackRate.setTargetAtTime(mix.rate, this.ctx.currentTime, 0.1);
  }

  play(name: OneShot, rate = 1): void {
    if (this.muted || !this.ctx || !this.effects) return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate * (0.96 + Math.random() * 0.08);
    src.connect(this.effects);
    src.start();
  }

  suspend(): void {
    this.suspended = true;
    void this.ctx?.suspend().catch(() => {});
  }

  resume(): void {
    this.suspended = false;
    if (!this.muted) void this.ctx?.resume().catch(() => {});
  }

  dispose(): void {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.loops.clear();
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    const bus = (level: number) => {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(master);
      return g;
    };
    this.ambience = bus(0.55);
    this.movement = bus(0.8);
    this.effects = bus(0.9);
    // Slow gust drift on the wind bed.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const depth = ctx.createGain();
    depth.gain.value = 0.12;
    lfo.connect(depth).connect(this.ambience.gain);
    lfo.start();
    this.master = master;
    this.ctx = ctx;
    return ctx;
  }

  private load(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve();
    this.loading ??= Promise.all(
      CLIPS.map(async (name) => {
        try {
          const res = await fetch(`${this.base}${name}.mp3`);
          if (!res.ok) return;
          this.buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
        } catch {
          // Missing or undecodable clip: that sound is silent, the game carries on.
        }
      }),
    ).then(() => undefined);
    return this.loading;
  }

  private startLoops(): void {
    const ctx = this.ctx;
    if (!ctx || !this.ambience || !this.movement) return;
    for (const name of LOOPS) {
      if (this.loops.has(name)) continue;
      const buffer = this.buffers.get(name);
      if (!buffer) continue;
      const { start, end } = silenceBounds(buffer.getChannelData(0));
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.loopStart = start / buffer.sampleRate;
      src.loopEnd = end / buffer.sampleRate;
      const gain = ctx.createGain();
      gain.gain.value =
        name === 'slither' ? 0 : (name === 'wind-light') === (this.theme === 'light') ? 1 : 0;
      src.connect(gain).connect(name === 'slither' ? this.movement : this.ambience);
      src.start(0, src.loopStart);
      this.loops.set(name, { src, gain });
    }
  }

  private ramp(node: GainNode | null | undefined, value: number, seconds = 0.05): void {
    if (!node || !this.ctx) return;
    const t = this.ctx.currentTime;
    node.gain.cancelScheduledValues(t);
    node.gain.setTargetAtTime(value, t, seconds / 3);
  }
}
