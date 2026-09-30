// [polish] Boot-bake worker: runs one JOBS entry per message and transfers the result back.

import { JOBS, type JobName } from './bake-jobs';
import { pack } from './bake-pack';

type Msg = { id: number; name: JobName; args: number[] };

self.onmessage = (e: MessageEvent<Msg>) => {
  const { id, name, args } = e.data;
  try {
    const t0 = performance.now();
    const r = (JOBS[name] as (...a: number[]) => unknown)(...args);
    const transfer: Transferable[] = [];
    const packed = pack(r, transfer);
    (self as unknown as Worker).postMessage({ id, ok: true, r: packed, ms: performance.now() - t0 }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, err: String(err) });
  }
};
