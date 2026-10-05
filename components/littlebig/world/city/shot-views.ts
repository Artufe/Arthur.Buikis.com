// The plan's review-shot viewpoints (rooftops, horizon, dusk) are solved by world/city/views.ts,
// which only the review tooling loads (core/shots.ts registers it). The plan's lazy getters call
// through here, so the sight-line code is not in the production bundle.

import type { Layout } from './layout';
import type { RoadGraph } from './graph';
import type { KeepOut } from './spatial';
import type { Building, Feature, Polyline, Viewpoint } from './types';

export type ShotViewName = 'rooftops' | 'horizon' | 'dusk';

/** What the plan hands the solver (its own build state). */
export interface ShotViewInputs {
  seed: number;
  g: RoadGraph;
  layout: Layout;
  buildings: Building[];
  features: Feature[];
  walkEdges: ReadonlyArray<{ kind: string; path: Polyline }>;
  parkPhi: number;
  keep: KeepOut;
  street: Viewpoint;
  obstacleNear(x: number, z: number, r: number): boolean;
}

export type ShotViewSolver = (name: ShotViewName, inputs: ShotViewInputs) => Viewpoint;

let solver: ShotViewSolver | null = null;

export function setShotViewSolver(s: ShotViewSolver): void {
  solver = s;
}

export function shotViewSolver(): ShotViewSolver {
  if (!solver) throw new Error('plan.viewpoints.rooftops/horizon/dusk need world/city/views.ts: call registerShotViews() (review tooling only)');
  return solver;
}
