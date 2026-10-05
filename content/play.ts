// Data for the /play page, the home "Play" strip and llms.txt. Every claim here is sourced in
// docs/superpowers/specs/2026-10-04-play-page-design.md (Facts). Media lives in public/play/ and
// is regenerated with docs/play-media.md.

export const PLAY_REPO = 'https://github.com/Artufe/Arthur.Buikis.com';

export type PlayMedia = {
  poster: string; // public path, 1600×1000 jpg
  video: string; // public path, 1280×800 mp4
  alt: string;
};

export type PlayReceiptRow = {
  label: string;
  value: string;
  href?: string;
  desktopOnly?: boolean; // hidden below 640px
};

export type PlayGame = {
  slug: 'snake' | 'goldenline' | 'littlebig';
  title: string;
  href: '/snake/' | '/surf/' | '/planet/';
  cmd: string;
  description: string;
  chip: { label: string; short?: string; tone: 'ok' | 'warn' };
  touchCta: string;
  media: PlayMedia; // dark theme, or the only variant
  lightMedia?: PlayMedia; // present → swapped in under the light theme
  caption: string[]; // home-strip caption parts, first one is the name
  receipt: PlayReceiptRow[];
  pr: { number: number; date: string };
};

export type PlayStep = { label: string; highlight?: boolean };
export type PlayLane = { id: string; name: string };
export type PlayPhase = { label: string; note: string; lanes: PlayLane[] };

export type PlayMethod = {
  oneShot: { tag: string; title: string; body: string; chain: PlayStep[]; scores: string };
  orchestrated: {
    tag: string;
    title: string;
    body: string;
    pipeline: {
      head: { label: string; note: string }[];
      phaseA: { label: string; note: string; lanes: PlayLane[]; chain: PlayLane[] };
      gates: string[];
      phaseB: { label: string; note: string; lanes: PlayLane[] };
      tail: string[];
    };
  };
  harnessed: {
    tag: string;
    title: string;
    body: string;
    pipeline: {
      head: { label: string; note: string }[];
      // A gate row follows a phase when it names one.
      phases: (PlayPhase & { gate?: string })[];
      lenses: string[]; // what every gate reviewed
      loop: string; // the per-build critic loop, drawn as ↻ on each lane
      tail: string[];
    };
    scores: string;
  };
  mine: { step: string; scope: string }[];
  sources: { game: string; links: { label: string; href: string }[] }[];
};

export const games: PlayGame[] = [
  {
    slug: 'snake',
    title: 'Snake',
    href: '/snake/',
    cmd: './snake --about',
    description:
      'Free-steering 3D snake on desert sand. Your trail carves a groove that fades in ten seconds. Keys, mouse or touch.',
    chip: { label: 'touch ok', tone: 'ok' },
    touchCta: 'play',
    media: {
      poster: '/play/snake-dark.jpg',
      video: '/play/snake-dark.mp4',
      alt: 'A green banded snake curls across moonlit sand ripples, its groove fading behind it, beside a glowing golden gem.',
    },
    lightMedia: {
      poster: '/play/snake-light.jpg',
      video: '/play/snake-light.mp4',
      alt: 'A green banded snake curls across sunlit desert sand, its groove fading behind it, beside a glowing golden gem.',
    },
    caption: ['snake', 'three.js · 3d', '40 min · one-shot'],
    receipt: [
      { label: 'Model', value: 'Claude Opus 5.5', desktopOnly: true },
      { label: 'Mode', value: 'one-shot · 1 agent' },
      { label: 'Time', value: '40 min' },
      { label: 'Code', value: '~4.5k lines ts' },
      { label: 'Tests', value: '11 spec files', desktopOnly: true },
      { label: 'Source', value: 'PR #43 ↗', href: `${PLAY_REPO}/pull/43` },
    ],
    pr: { number: 43, date: 'sep 2026' },
  },
  {
    slug: 'goldenline',
    title: 'GOLDENLINE',
    href: '/surf/',
    cmd: './goldenline --about',
    description:
      'A first-person reef break at golden hour. Walk the sand, run off the pier, paddle out and ride an overhead wave.',
    chip: { label: 'desktop · webgpu · keyboard', short: 'desktop · webgpu', tone: 'warn' },
    touchCta: 'open',
    media: {
      poster: '/play/goldenline.jpg',
      video: '/play/goldenline.mp4',
      alt: 'A turquoise wave pitches into a barrel on a reef, spray streaming off the lip, with a wooden pier on the golden-hour horizon.',
    },
    caption: ['goldenline', 'webgpu · tsl', '2 evenings · 11 agents'],
    receipt: [
      { label: 'Model', value: 'Claude Opus 5.5', desktopOnly: true },
      { label: 'Mode', value: '1 orchestrator + 10 agents' },
      { label: 'Time', value: '2 evenings' },
      { label: 'Code', value: '~31k lines ts' },
      { label: 'Engine', value: 'three.js webgpu · tsl', desktopOnly: true },
      { label: 'Source', value: 'PR #44 ↗', href: `${PLAY_REPO}/pull/44` },
    ],
    pr: { number: 44, date: 'sep 2026' },
  },
  {
    slug: 'littlebig',
    title: 'LITTLEBIG',
    href: '/planet/',
    cmd: './littlebig --about',
    description:
      'A tiny cartoon planet. Spin it, then dive through the clouds and walk its streets. Everything is procedural: zero asset downloads.',
    chip: { label: 'touch ok', tone: 'ok' },
    touchCta: 'play',
    // One clip for both themes (the game has no light / dark mode). Recipe: docs/play-media.md.
    media: {
      poster: '/play/littlebig.jpg',
      video: '/play/littlebig.mp4',
      alt: 'A tiny cartoon planet against deep blue space: a toy-bright downtown of towers and a clock tower rises on its curve, ringed by roads, red-roofed houses and green parkland, with puffy clouds and a striped hot-air balloon drifting past.',
    },
    caption: ['littlebig', 'three.js · webgl', 'overnight · 11 builders'],
    receipt: [
      { label: 'Model', value: 'Claude Opus 5.5', desktopOnly: true },
      { label: 'Mode', value: '1 orchestrator + 11 builders' },
      { label: 'Time', value: '17 hours' },
      { label: 'Code', value: '~30k lines ts' },
      { label: 'Tests', value: '23 spec files', desktopOnly: true },
      { label: 'Source', value: 'PR #49 ↗', href: `${PLAY_REPO}/pull/49` },
    ],
    pr: { number: 49, date: 'oct 2026' },
  },
];

export const method: PlayMethod = {
  oneShot: {
    tag: '01 · one-shot',
    title: 'Snake: one prompt, forty minutes.',
    body: 'A benchmark of sorts for a new model. Claude Opus 5.5 rebuilt the old 2D snake as a 3D game from a single prompt, natively, with no orchestration.',
    chain: [
      { label: 'prompt' },
      { label: 'spec' },
      { label: 'plan' },
      { label: 'build' },
      { label: 'critic ×3', highlight: true },
      { label: 'PR #43' },
    ],
    scores: 'A fresh critic agent scored 36 screenshots per round: 6 → 7 → 7.5 / 10',
  },
  orchestrated: {
    tag: '02 · orchestrated',
    title: 'GOLDENLINE: one orchestrator, ten agents.',
    body: 'I wrote the brief and defined the agent tasks. The orchestrator built the shared core and contracts, then ran the agents in two phases. Each agent owned one system and ran its own review loop.',
    pipeline: {
      head: [
        { label: 'brief', note: 'my prompt' },
        { label: 'orchestrator', note: 'core · contracts · review tooling · integration' },
      ],
      phaseA: {
        label: 'phase a · parallel',
        note: '≤ 6 at once',
        lanes: [
          { id: 'A1', name: 'atmosphere + post' },
          { id: 'A3', name: 'beach & sand' },
          { id: 'A4', name: 'pier' },
          { id: 'A5', name: 'surface state' },
          { id: 'A6', name: 'first-person player' },
        ],
        chain: [
          { id: 'A2', name: 'ocean' },
          { id: 'A7', name: 'water shading' },
          { id: 'A8', name: 'breaking waves' },
        ],
      },
      gates: ['review gates · M2 beauty shot · M3 waves in motion', 'look pass'],
      phaseB: {
        label: 'phase b',
        note: 'sequential',
        lanes: [
          { id: 'B1', name: 'surfing' },
          { id: 'B2', name: 'polish · perf · startup' },
        ],
      },
      tail: ['final review', 'PR #44'],
    },
  },
  harnessed: {
    tag: '03 · harnessed',
    title: 'LITTLEBIG: one prompt, a harness of agents.',
    body: 'One prompt from me, with the limits: quality first, small and fast, at most four agents at once. The orchestrator wrote the brief and split it into eleven builder tasks, then ran them in four phases.',
    pipeline: {
      head: [
        { label: 'prompt', note: 'mine' },
        { label: 'orchestrator', note: 'brief · task split · integration · gates' },
      ],
      phases: [
        {
          label: 'phase 1 · foundation',
          note: '1 agent',
          lanes: [{ id: 'F0', name: 'engine · contracts · world gen · camera' }],
        },
        {
          label: 'phase 2 · world',
          note: '≤ 4 at once',
          lanes: [
            { id: 'A1', name: 'terrain · ocean · nature' },
            { id: 'A2', name: 'city' },
            { id: 'A3', name: 'sky · clouds · light' },
            { id: 'A4', name: 'camera' },
          ],
          gate: 'gate G1',
        },
        {
          label: 'phase 3 · life and look',
          note: '≤ 4 at once',
          lanes: [
            { id: 'B1', name: 'traffic' },
            { id: 'B2', name: 'people' },
            { id: 'B3', name: 'air' },
            { id: 'B4', name: 'ink · post' },
          ],
          gate: 'gate G2',
        },
        {
          label: 'phase 4 · site',
          note: 'parallel',
          lanes: [
            { id: 'C1', name: 'site integration' },
            { id: 'C2', name: 'load · size · perf' },
          ],
        },
      ],
      lenses: ['art & wow', 'life & flow', 'perf & size'],
      loop: 'critic → refine',
      tail: ['final review', 'PR #49'],
    },
    scores:
      'Every build got a fresh critic that scored its screenshots at each altitude. Under 8.5 / 10 it went back for a refine round; all 8 world and life builds did.',
  },
  // The steps differ per game: say which game each one covers.
  mine: [
    { step: 'Wrote the prompts', scope: 'all three' },
    { step: 'Chose what to focus on', scope: 'all three · plus the limits for littlebig' },
    { step: 'Defined the agent tasks', scope: 'goldenline only · littlebig’s orchestrator split its own' },
    { step: 'Reviewed the results', scope: 'all three' },
  ],
  sources: [
    {
      game: 'snake',
      links: [
        { label: 'spec ↗', href: `${PLAY_REPO}/blob/master/docs/superpowers/specs/2026-09-25-snake-3d-design.md` },
        { label: 'PR #43 ↗', href: `${PLAY_REPO}/pull/43` },
      ],
    },
    {
      game: 'goldenline',
      links: [
        { label: 'BRIEF.md ↗', href: `${PLAY_REPO}/blob/master/docs/goldenline/BRIEF.md` },
        { label: 'TASKS.md ↗', href: `${PLAY_REPO}/blob/master/docs/goldenline/TASKS.md` },
        { label: 'DECISIONS.md ↗', href: `${PLAY_REPO}/blob/master/docs/goldenline/DECISIONS.md` },
        { label: 'PR #44 ↗', href: `${PLAY_REPO}/pull/44` },
      ],
    },
    {
      game: 'littlebig',
      links: [
        { label: 'BRIEF.md ↗', href: `${PLAY_REPO}/blob/master/docs/littlebig/BRIEF.md` },
        { label: 'TASKS.md ↗', href: `${PLAY_REPO}/blob/master/docs/littlebig/TASKS.md` },
        { label: 'DECISIONS.md ↗', href: `${PLAY_REPO}/blob/master/docs/littlebig/DECISIONS.md` },
        { label: 'PR #49 ↗', href: `${PLAY_REPO}/pull/49` },
      ],
    },
  ],
};
