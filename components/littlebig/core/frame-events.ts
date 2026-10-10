/** Presentation subscribers run after the engine presents a frame. No independent RAFs. */
export class FrameEvents {
  private readonly listeners = new Set<(now: number) => void>();
  private disposed = false;

  subscribe(fn: (now: number) => void): () => void {
    if (!this.disposed) this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  emit(now: number): void {
    for (const fn of this.listeners) {
      try { fn(now); } catch (error) {
        // A broken overlay must not stop simulation or leave a runaway callback.
        this.listeners.delete(fn);
        console.error('[littlebig] presentation subscriber failed', error);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
