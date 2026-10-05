// Specs: import this FIRST, before any review-tooling module (camera/dive.ts, core/shots.ts,
// world/city/views.ts), so core/debug-kit.ts is filled when they evaluate.
import { useKit } from './debug-kit';
import { KIT } from './kit';

useKit(KIT);
