// The HUD's stylesheet, scoped under .lbh (the HUD root). POP art × cartoon: ink outlines, hard
// offset shadows, the game palette, halftone dots, comic bursts, springy presses.
//
// Round shapes: the site's global `* { border-radius: 0 !important }` is beaten by specificity —
// every rounded rule here is `.lbh .x { border-radius: … !important }` (0,2,0 over 0,0,0). Nothing
// outside .lbh is touched (DECISIONS.md [v2-U1]).

import { C, FONT_MONO, FONT_POP } from './theme';

const INK = C.ink;
const HALFTONE = `radial-gradient(circle, rgba(27,21,48,0.13) 1.05px, transparent 1.5px)`;
const SPRING = 'cubic-bezier(.3,1.65,.5,1)';

export const HUD_CSS = /* css */ `
.lbh{position:absolute;inset:0;pointer-events:none;z-index:3;font-family:${FONT_POP};color:${INK};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;user-select:none;-webkit-user-select:none;overflow:hidden}
.lbh *{box-sizing:border-box}
.lbh>*{z-index:2}
.lbh>.lbh-labels{z-index:0}
.lbh>.lbh-hover{z-index:1}
.lbh button{font:inherit;color:inherit;margin:0;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.lbh button:focus{outline:none}
.lbh h2,.lbh p{font-family:${FONT_POP};margin:0;text-transform:none;letter-spacing:normal}
.lbh svg{pointer-events:none}

/* ── mode dock ── */
.lbh .lbh-dock{position:absolute;left:50%;bottom:14px;display:flex;gap:4px;padding:6px 8px 7px;pointer-events:auto;transform:translateX(-50%);
  background:${C.paper} ${HALFTONE} 0 0/6px 6px;border:3px solid ${INK};border-radius:24px !important;box-shadow:5px 5px 0 ${INK};
  transition:transform .35s ${SPRING},opacity .25s}
.lbh .lbh-mode{position:relative;display:flex;flex-direction:column;align-items:center;gap:5px;width:64px;padding:2px 0 0;background:none;border:0;cursor:pointer}
.lbh .lbh-disc{position:relative;display:grid;place-items:center;width:50px;height:50px;background:${C.cream};border:2.5px solid ${INK};border-radius:999px !important;
  box-shadow:0 3.5px 0 ${INK};--lbf:${C.paper};transition:transform .18s ${SPRING},box-shadow .18s ${SPRING},background-color .2s}
.lbh .lbh-dwrap{position:relative;display:block}
.lbh .lbh-dwrap>.lbh-disc{z-index:1}
.lbh .lbh-mode:hover:not(:disabled) .lbh-disc{transform:translateY(-2px);box-shadow:0 5.5px 0 ${INK}}
.lbh .lbh-mode:active:not(:disabled) .lbh-disc{transform:translateY(3px);box-shadow:0 0.5px 0 ${INK}}
.lbh .lbh-mode[aria-pressed="true"] .lbh-disc{background:var(--mc);--lbf:#fff;transform:translateY(2px);box-shadow:0 1.5px 0 ${INK},inset 0 -4px 0 rgba(27,21,48,.16)}
.lbh .lbh-mode .lbh-pow{position:absolute;left:50%;top:50%;width:66px;height:66px;margin:-32px 0 0 -33px;opacity:0;transform:scale(.2) rotate(-40deg);transition:opacity .15s,transform .3s ${SPRING};z-index:0}
.lbh .lbh-mode[aria-pressed="true"] .lbh-pow{opacity:1;transform:scale(1) rotate(0deg)}
.lbh .lbh-cap{font-size:11.5px;font-weight:800;line-height:1;letter-spacing:.01em;padding:3px 7px 4px;border-radius:99px !important;white-space:nowrap}
.lbh .lbh-mode[aria-pressed="true"] .lbh-cap{background:${INK};color:${C.paper}}
.lbh .lbh-mode:disabled{cursor:default}
.lbh .lbh-mode:disabled .lbh-disc{background:#E9E2D2;box-shadow:0 1px 0 rgba(27,21,48,.5);border-color:rgba(27,21,48,.45);color:rgba(27,21,48,.42);--lbf:#F2EDE2}
.lbh .lbh-mode:disabled .lbh-cap{opacity:.45}
.lbh .lbh-key{position:absolute;top:-3px;right:1px;z-index:2;min-width:17px;padding:2px 4px 1px;font:800 10px/1 ${FONT_POP};text-align:center;color:${INK};background:#fff;border:1.5px solid ${INK};border-bottom-width:2.5px;border-radius:4px !important}
.lbh .lbh-mode:disabled .lbh-key,.lbh .lbh-mode[aria-pressed="true"] .lbh-key{display:none}
.lbh .lbh-mode:focus-visible .lbh-disc{outline:3px solid ${C.accent};outline-offset:3px}
.lbh .lbh-tip{position:absolute;bottom:calc(100% + 12px);left:50%;transform:translateX(-50%) translateY(4px);opacity:0;pointer-events:none;white-space:nowrap;
  font-size:12.5px;font-weight:800;padding:4px 6px 5px 10px;background:${C.paper};color:${INK};border:2.5px solid ${INK};border-radius:11px !important;box-shadow:3px 3px 0 ${INK};transition:opacity .12s,transform .2s ${SPRING}}
.lbh .lbh-tip::after{content:'';position:absolute;top:calc(100% + 2px);left:50%;margin-left:-7px;border:7px solid transparent;border-top-color:${INK}}
.lbh .lbh-tip kbd{display:inline-block;min-width:18px;margin-left:7px;padding:2px 5px 1px;font:800 11px/1.1 ${FONT_POP};text-align:center;color:${INK};background:${C.accent};border:1.5px solid ${INK};border-bottom-width:3px;border-radius:5px !important}
.lbh .lbh-dock .lbh-mode:hover .lbh-tip,.lbh .lbh-dock .lbh-mode:focus-visible .lbh-tip{opacity:1;transform:translateX(-50%) translateY(0)}
.lbh .lbh-dock .lbh-mode[data-quiet] .lbh-tip{opacity:0}
.lbh[data-compact] .lbh-dock{gap:2px;padding:5px 6px 6px;border-radius:999px !important;box-shadow:4px 4px 0 ${INK}}
.lbh[data-compact] .lbh-mode{width:46px;padding:0}
.lbh[data-compact] .lbh-disc{width:42px;height:42px}
.lbh[data-compact] .lbh-mode .lbh-pow{width:58px;height:58px;margin:-28px 0 0 -29px}
.lbh[data-compact] .lbh-cap{display:none}
.lbh[data-narrow] .lbh-dock{bottom:10px}
.lbh[data-narrow] .lbh-mode{width:44px}
.lbh[data-narrow] .lbh-key,.lbh[data-touch] .lbh-key{display:none}
.lbh[data-touch] .lbh-tip{display:none}
/* Landscape: a rail on the right edge, in the empty space beside the planet. */
.lbh[data-rail] .lbh-dock{left:auto;right:14px;top:50%;bottom:auto;transform:translateY(-50%);flex-direction:column;gap:3px;padding:8px 6px 9px;border-radius:26px !important}
.lbh[data-rail][data-short] .lbh-dock{top:64px;transform:none}
.lbh[data-rail][data-compact] .lbh-dock{right:10px;padding:6px 5px;gap:2px;border-radius:999px !important}
.lbh[data-rail] .lbh-tip{bottom:auto;left:auto;right:calc(100% + 16px);top:27px;transform:translateY(-50%) translateX(6px)}
.lbh[data-rail] .lbh-tip::after{top:50%;left:calc(100% + 2px);margin:-7px 0 0;border-top-color:transparent;border-left-color:${INK}}
.lbh[data-rail] .lbh-dock .lbh-mode:hover .lbh-tip,.lbh[data-rail] .lbh-dock .lbh-mode:focus-visible .lbh-tip{transform:translateY(-50%) translateX(0)}
.lbh[data-rail][data-compact] .lbh-tip{top:23px}
/* Touch at street level: the left thumb owns the bottom-left, so the dock stands up bottom right. */
.lbh[data-stick] .lbh-dock{left:auto;right:10px;top:auto;bottom:14px;transform:none;flex-direction:column;border-radius:999px !important}
.lbh[data-squat] .lbh-dock{display:grid;grid-template-columns:repeat(2,44px);gap:4px;left:auto;right:10px;top:auto;bottom:10px;transform:none;padding:7px;border-radius:20px !important}
.lbh[data-squat] .lbh-mode{width:44px;min-height:44px}
.lbh[data-squat] .lbh-tl{right:126px}
.lbh[data-squat] .lbh-card{max-width:100%}
/* The active name stays inside the touch dock so hints cannot cover it. */
.lbh .lbh-active-name{display:none}
.lbh[data-touch] .lbh-active-name{display:block;position:absolute;left:50%;bottom:2px;transform:translateX(-50%);padding:1px 8px;border-radius:99px !important;background:${C.paper};font-size:11px;font-weight:800;line-height:14px;white-space:nowrap;pointer-events:none}
.lbh[data-touch] .lbh-mode{min-height:44px}
.lbh[data-touch] .lbh-btn{width:44px;height:44px}

/* ── the top-left column: the card, and the hint under it (slot 'stack'). Below the page's back link
   (12 + 38 + 12), clear of the rail on the right; the card never needs measuring to stack the hint. ── */
.lbh .lbh-tl{position:absolute;left:16px;right:16px;top:16px;display:flex;flex-direction:column;align-items:flex-start;gap:12px;pointer-events:none}
.lbh[data-variant="page"] .lbh-tl{top:62px}
.lbh[data-rail] .lbh-tl{right:118px}
.lbh[data-compact] .lbh-tl{left:10px;right:10px;top:10px;gap:10px}
.lbh[data-compact][data-variant="page"] .lbh-tl{top:62px}
.lbh[data-compact][data-variant="window"]:not([data-rail]) .lbh-tl{right:64px}
.lbh[data-compact][data-rail] .lbh-tl{right:84px}
.lbh[data-narrow] .lbh-tl,.lbh[data-narrow][data-variant] .lbh-tl{top:64px;right:10px}

/* ── follow card ── */
.lbh .lbh-card{position:relative;flex:none;width:368px;pointer-events:auto;display:grid;grid-template-columns:58px 1fr;column-gap:12px;row-gap:9px;padding:12px 12px 11px;
  background:linear-gradient(100deg,${C.paper} 64%,rgba(255,248,232,0.2) 96%),radial-gradient(circle,var(--kc) 1.5px,transparent 1.9px) 0 0/7px 7px,${C.paper};border:3px solid ${INK};border-radius:20px !important;box-shadow:6px 6px 0 ${INK};transform-origin:20% 0;animation:lbh-pop .42s ${SPRING} both}
.lbh .lbh-card[data-out]{animation:lbh-out .22s ease-in both}
.lbh .lbh-badge{position:relative;width:58px;height:58px;display:grid;place-items:center;color:${INK};--lbf:#fff}
.lbh .lbh-badge>svg:first-child{position:absolute;inset:-5px;width:68px;height:68px;animation:lbh-burst 18s linear infinite}
.lbh .lbh-badge>svg+svg{position:relative}
.lbh .lbh-head{min-width:0;display:flex;flex-direction:column;justify-content:center;gap:3px}
.lbh .lbh-kind{align-self:flex-start;font:800 11px/1 ${FONT_POP};letter-spacing:.1em;text-transform:lowercase;padding:3px 7px 4px 8px;background:${INK};color:var(--kc);transform:rotate(-2.5deg);border-radius:4px !important}
.lbh .lbh-title{padding-right:18px;font-size:19px;font-weight:900;line-height:1.04;letter-spacing:-.005em;text-wrap:balance;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.lbh .lbh-sub{font:700 12.5px/1.22 ${FONT_POP};color:rgba(27,21,48,.74);text-wrap:balance;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.lbh .lbh-row{grid-column:1/-1;display:flex;align-items:stretch;gap:7px}
.lbh .lbh-live{flex:1;min-width:0;min-height:40px;display:flex;align-items:center;gap:8px;padding:5px 10px;font:700 12px/1.25 ${FONT_MONO};background:var(--kc) ${HALFTONE} 0 0/5px 5px;border:2.5px solid ${INK};border-radius:12px !important;overflow:hidden}
.lbh .lbh-ltext{position:relative;flex:1;min-width:0;overflow:hidden;--lbh-ll:3}
.lbh .lbh-ll{display:block;white-space:pre}
.lbh .lbh-probe{position:absolute;left:0;top:0;visibility:hidden;white-space:pre;pointer-events:none}
.lbh .lbh-live i{flex:none;width:8px;height:8px;background:${C.roofRed};border:1.5px solid ${INK};border-radius:99px !important;animation:lbh-blink 1.2s steps(2,start) infinite}
.lbh .lbh-btn{flex:none;display:grid;place-items:center;width:40px;height:40px;padding:0;cursor:pointer;background:${C.cream};border:2.5px solid ${INK};border-radius:12px !important;box-shadow:0 3px 0 ${INK};transition:transform .16s ${SPRING},box-shadow .16s ${SPRING}}
.lbh .lbh-btn:hover:not(:disabled){transform:translateY(-1.5px);box-shadow:0 4.5px 0 ${INK}}
.lbh .lbh-btn:active:not(:disabled){transform:translateY(3px);box-shadow:0 0 0 ${INK}}
.lbh .lbh-btn:disabled{opacity:.4;cursor:default;box-shadow:none}
.lbh .lbh-btn:focus-visible,.lbh .lbh-x:focus-visible,.lbh .lbh-time:focus-visible .lbh-tdisc,.lbh .lbh-ok:focus-visible,.lbh .lbh-tag:focus-visible .lbh-tag-box{outline:3px solid ${C.accent};outline-offset:2px}
.lbh .lbh-x{position:absolute;top:-14px;right:-14px;width:40px;height:40px;display:grid;place-items:center;padding:0;cursor:pointer;color:#fff;background:${C.roofRed};border:3px solid ${INK};border-radius:999px !important;box-shadow:3px 3px 0 ${INK};transition:transform .18s ${SPRING}}
.lbh .lbh-x:hover{transform:rotate(90deg) scale(1.06)}
.lbh .lbh-x:active{transform:scale(.9)}
.lbh[data-compact] .lbh-card{width:344px;grid-template-columns:48px 1fr;column-gap:10px;padding:10px 10px 9px;box-shadow:5px 5px 0 ${INK}}
.lbh[data-compact] .lbh-badge{width:48px;height:48px}
.lbh[data-compact] .lbh-badge>svg:first-child{inset:-4px;width:56px;height:56px}
.lbh[data-compact] .lbh-title{font-size:16.5px}
.lbh[data-compact] .lbh-sub{font-size:12px}
/* (Compact, narrow and short: 11 px mono, slimmer padding; the card is wide enough for ~28 columns.) */
.lbh[data-compact] .lbh-live,.lbh[data-narrow] .lbh-live,.lbh[data-short] .lbh-live{font-size:11px;padding:4px 8px;gap:6px}
.lbh[data-narrow] .lbh-live{padding:4px 6px}
/* Short (a phone on its side): a slimmer card, two live lines at most (the least important piece goes). */
.lbh[data-short] .lbh-card{width:328px;grid-template-columns:38px 1fr;column-gap:10px;row-gap:7px;padding:8px 9px 8px;box-shadow:4px 4px 0 ${INK}}
.lbh[data-short] .lbh-badge{width:38px;height:38px}
.lbh[data-short] .lbh-badge>svg:first-child{inset:-4px;width:46px;height:46px}
.lbh[data-short] .lbh-badge>svg+svg{width:22px;height:22px}
.lbh[data-short] .lbh-kind{display:none}
.lbh[data-short] .lbh-head{gap:2px}
.lbh[data-short] .lbh-title{font-size:15px}
.lbh[data-short] .lbh-sub{font-size:11px}
.lbh[data-short] .lbh-ltext{--lbh-ll:2}
.lbh[data-short] .lbh-x{top:-9px;right:-9px}
.lbh[data-compact] .lbh-x{top:-10px;right:-10px}
.lbh[data-narrow] .lbh-card{align-self:stretch;width:auto;max-width:420px}
.lbh[data-narrow] .lbh-x{top:8px;right:8px;width:40px;height:40px;box-shadow:2px 2px 0 ${INK}}
.lbh[data-narrow] .lbh-head{padding-right:44px}
.lbh .lbh-card-toggle{grid-column:1/-1;justify-self:start;min-height:44px;padding:0 10px;border:2px solid ${INK};border-radius:10px !important;background:${C.cream};font-size:12px;font-weight:800;cursor:pointer;display:none}
.lbh[data-compact] .lbh-card-toggle{display:block}
.lbh[data-compact] .lbh-card[data-collapsed] .lbh-row,.lbh[data-compact] .lbh-card[data-collapsed] .lbh-sub{display:none}
.lbh[data-compact] .lbh-card[data-collapsed]{row-gap:4px;grid-template-columns:1fr auto}
.lbh[data-compact] .lbh-card[data-collapsed] .lbh-badge{display:none}
.lbh[data-compact] .lbh-card[data-collapsed] .lbh-head{grid-column:1/-1}
.lbh[data-compact] .lbh-card[data-collapsed] .lbh-kind{display:none}
.lbh[data-compact] .lbh-card[data-collapsed] .lbh-card-toggle{grid-column:1/-1}
.lbh .lbh-card-toggle:focus-visible{outline:3px solid ${C.accent};outline-offset:2px}

/* ── time button ── */
.lbh .lbh-time{position:absolute;top:12px;right:12px;display:flex;align-items:center;padding:0;background:none;border:0;cursor:pointer;pointer-events:auto}
.lbh .lbh-tcap{margin-right:-14px;padding:6px 22px 7px 12px;font-size:12.5px;font-weight:800;line-height:1;white-space:nowrap;background:${C.paper};border:2.5px solid ${INK};border-right:0;border-radius:99px 0 0 99px !important;box-shadow:0 3px 0 ${INK}}
.lbh .lbh-tcap small{display:block;font:800 10.5px/1 ${FONT_POP};letter-spacing:.05em;color:rgba(27,21,48,.64);margin-bottom:3px}
.lbh .lbh-tdisc{position:relative;width:48px;height:48px;display:grid;place-items:center;background:var(--td);border:3px solid ${INK};border-radius:999px !important;box-shadow:3px 3px 0 ${INK};color:${INK};transition:transform .2s ${SPRING},background-color .4s}
.lbh .lbh-time:hover .lbh-tdisc{transform:rotate(-12deg) scale(1.05)}
.lbh .lbh-time:active .lbh-tdisc{transform:scale(.92)}
.lbh .lbh-tdisc .lbh-ring{position:absolute;inset:-7px;width:calc(100% + 14px);height:calc(100% + 14px);transform:rotate(-90deg)}
.lbh .lbh-time[data-warp] .lbh-tdisc>svg:last-child{animation:lbh-spin 2.4s linear infinite}
.lbh[data-compact] .lbh-tcap{display:none}
.lbh[data-compact] .lbh-tdisc{width:44px;height:44px}
.lbh[data-compact] .lbh-time{top:10px;right:10px}

/* ── hint row: keycap chips in a paper pill. Its slot (hud.tsx hintSlot) never shares space with a
   panel: 'stack' under the card (or the back link) in the top-left column, 'bl' bottom left beside
   the planet (landscape), 'top' centred between the back link and the time button (--lbh-ti, the
   same inset both sides), 'bottom' just above the dock (--lbh-dt). Too wide: segments drop out. ── */
.lbh .lbh-hint{display:flex;align-items:center;flex-wrap:nowrap;gap:12px;max-width:100%;padding:5px 13px 5px 6px;font:700 12.5px/1 ${FONT_POP};white-space:nowrap;overflow:hidden;
  color:${INK};background:${C.paper};border:2.5px solid ${INK};border-radius:99px !important;box-shadow:3px 3px 0 ${INK};transition:opacity .6s ease,transform .6s ${SPRING}}
.lbh .lbh-hseg{display:inline-flex;align-items:center;gap:4px;flex:none}
.lbh .lbh-hseg[hidden]{display:none}
.lbh .lbh-hseg:not([data-first])::before{content:'';width:5px;height:5px;margin-right:6px;background:${C.accent};border:1.5px solid ${INK};border-radius:99px !important}
.lbh .lbh-hint kbd{display:inline-block;min-width:20px;padding:3px 6px 2px;font:800 11.5px/1.1 ${FONT_POP};text-align:center;color:${INK};background:#fff;border:1.5px solid ${INK};border-bottom-width:3px;border-radius:6px !important}
.lbh .lbh-hint[data-snap]{transition:none}
.lbh .lbh-hint[data-slot="stack"]{position:relative;flex:none}
.lbh .lbh-hint[data-slot="bl"]{position:absolute;left:14px;bottom:14px;max-width:calc(100% - 130px)}
.lbh .lbh-hint[data-slot="top"]{position:absolute;top:13px;left:var(--lbh-ti,150px);right:var(--lbh-ti,150px);width:max-content;margin:0 auto;max-width:calc(100% - 2 * var(--lbh-ti,150px))}
.lbh .lbh-hint[data-slot="bottom"]{position:absolute;left:12px;right:12px;bottom:calc(var(--lbh-dt,80px) + 10px);width:max-content;margin:0 auto;max-width:calc(100% - 24px)}
.lbh .lbh-hint[data-off]{opacity:0;transform:translateY(-6px)}
.lbh .lbh-hint[data-slot="bl"][data-off],.lbh .lbh-hint[data-slot="bottom"][data-off]{transform:translateY(6px)}
.lbh[data-compact] .lbh-hint{font-size:12px;gap:10px}
.lbh[data-compact] .lbh-hint[data-slot="bl"]{left:10px;bottom:10px;max-width:calc(100% - 92px)}
.lbh[data-narrow] .lbh-hint{gap:7px;padding:4px 9px 4px 5px;font-size:11px}
.lbh[data-narrow] .lbh-hint kbd{font-size:10.5px;padding:2px 4px 1px;min-width:16px}
.lbh[data-narrow] .lbh-hseg:not([data-first])::before{margin-right:3px;width:4px;height:4px}

/* ── coach mark: a comic speech bubble. Its corner (data-cpos, hud.tsx) is the first one clear of the
   planet's disc: 'bc' above the dock (portrait, its tail on the dock), 'bl' / 'tl' beside the planet
   (landscape). Compact layouts get a smaller bubble with a round 'got it' sticker on its corner. ── */
.lbh .lbh-coach{position:absolute;width:max-content;max-width:min(380px,calc(100% - 40px));pointer-events:auto;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"m ok" "s ok";align-items:center;column-gap:14px;row-gap:5px;padding:13px 13px 13px 30px;
  background:#fff;border:3px solid ${INK};border-radius:18px !important;box-shadow:5px 5px 0 ${INK};animation:lbh-pop .5s ${SPRING} both}
.lbh .lbh-coach p{margin:0}
.lbh .lbh-c-main{grid-area:m;font-size:14.5px;font-weight:800;line-height:1.22;text-wrap:balance}
.lbh .lbh-c-sub{grid-area:s;font:700 12px/1.3 ${FONT_POP};color:rgba(27,21,48,.66);text-wrap:balance}
.lbh .lbh-c-keys{white-space:nowrap}
.lbh .lbh-c-side,.lbh[data-rail] .lbh-c-below{display:none}
.lbh[data-rail] .lbh-c-side{display:inline}
.lbh .lbh-psst{position:absolute;left:-30px;top:-30px;width:60px;height:60px;display:grid;place-items:center;transform:rotate(-14deg)}
.lbh .lbh-psst svg{position:absolute;inset:0}
.lbh .lbh-psst b{position:relative;font-size:13px;font-weight:900;color:${INK}}
.lbh .lbh-ok{grid-area:ok;flex:none;height:40px;padding:0 14px;font-size:13px;font-weight:900;cursor:pointer;background:${C.accent};border:2.5px solid ${INK};border-radius:99px !important;box-shadow:0 3px 0 ${INK};transition:transform .16s ${SPRING},box-shadow .16s}
.lbh .lbh-ok:active{transform:translateY(3px);box-shadow:0 0 0 ${INK}}
.lbh .lbh-note{grid-template-columns:auto;grid-template-areas:"m";padding:10px 16px}
.lbh .lbh-note .lbh-c-main{font-size:13.5px}
.lbh .lbh-coach[data-cpos="bc"]{left:50%;bottom:calc(var(--lbh-dt,80px) + 16px);transform:translateX(-50%);animation-name:lbh-pop-c}
.lbh .lbh-coach[data-cpos="bc"]::after{content:'';position:absolute;left:50%;bottom:-11px;width:18px;height:18px;margin-left:-9px;background:#fff;border-right:3px solid ${INK};border-bottom:3px solid ${INK};transform:rotate(45deg)}
.lbh .lbh-coach[data-cpos="bl"]{left:30px;bottom:16px;max-width:min(380px,calc(100% - 150px));transform-origin:0 100%}
.lbh .lbh-coach[data-cpos="tl"]{left:16px;top:16px;max-width:min(380px,calc(100% - 150px));padding:13px 26px 13px 15px;transform-origin:0 0}
.lbh[data-variant="page"] .lbh-coach[data-cpos="tl"]{top:68px}
.lbh .lbh-coach[data-cpos="tl"] .lbh-psst{left:auto;right:-26px;top:-24px;transform:rotate(12deg)}
.lbh .lbh-note[data-cpos]{padding:10px 16px}
/* Compact (the window, phones): a smaller bubble, the 'got it' sticker on its top-right corner. */
.lbh[data-compact] .lbh-coach{grid-template-columns:minmax(0,1fr);grid-template-areas:"m" "s";row-gap:4px;max-width:min(272px,calc(100% - 40px));padding:11px 30px 11px 27px}
.lbh[data-compact] .lbh-c-main{font-size:13px}
.lbh[data-compact] .lbh-c-sub{font-size:11.5px}
.lbh[data-compact] .lbh-c-keys{display:none}
.lbh[data-compact] .lbh-psst{left:-24px;top:-26px;width:52px;height:52px}
.lbh[data-compact] .lbh-psst b{font-size:11.5px}
.lbh[data-compact] .lbh-ok{position:absolute;top:-15px;right:-15px;width:44px;height:44px;padding:0;font-size:11px;line-height:1;border-width:2.5px;border-radius:999px !important;box-shadow:2px 3px 0 ${INK};transform:rotate(8deg)}
.lbh[data-compact] .lbh-ok:active{transform:rotate(8deg) translateY(2px);box-shadow:1px 1px 0 ${INK}}
.lbh[data-compact] .lbh-coach[data-cpos="bc"]{bottom:calc(var(--lbh-dt,70px) + 16px)}
.lbh[data-compact] .lbh-coach[data-cpos="bl"]{left:22px;bottom:12px}
.lbh[data-compact] .lbh-coach[data-cpos="tl"]{left:14px;top:12px;padding:11px 32px 13px 30px}
.lbh[data-compact][data-variant="page"] .lbh-coach[data-cpos="tl"]{top:70px}
.lbh[data-compact] .lbh-coach[data-cpos="tl"] .lbh-psst{left:-20px;right:auto;top:auto;bottom:-26px;transform:rotate(-10deg)}
.lbh[data-compact] .lbh-note{padding:9px 14px}
.lbh[data-narrow] .lbh-coach{max-width:calc(100% - 52px)}
/* A phone on its side: the planet fills the height, so the bubble keeps to one thought (the rail is in plain view). */
.lbh[data-short] .lbh-c-sub{display:none}

/* ── world labels ── */
.lbh .lbh-labels{position:absolute;inset:0;pointer-events:none}
.lbh .lbh-tag{position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:center;padding:0;background:none;border:0;cursor:pointer;pointer-events:auto;will-change:transform,opacity;transform-origin:50% 100%;visibility:hidden;--tc:${C.paper};--tt:${INK}}
.lbh .lbh-tag::before{content:'';position:absolute;inset:-9px -5px -3px}
.lbh .lbh-tag[data-off]{pointer-events:none}
.lbh .lbh-tag-box{position:relative;display:flex;align-items:center;gap:5px;padding:3px 8px 4px;background:var(--tc);color:var(--tt);border:2px solid ${INK};border-radius:9px !important;box-shadow:2px 2px 0 ${INK};white-space:nowrap;transition:transform .16s ${SPRING},box-shadow .16s}
.lbh .lbh-tag:hover .lbh-tag-box{transform:translateY(-2px) rotate(-1.5deg);box-shadow:3px 4px 0 ${INK}}
.lbh .lbh-tag-txt{display:flex;flex-direction:column;align-items:flex-start;gap:2px}
.lbh .lbh-tag-name{font-size:12.5px;font-weight:800;line-height:1.05}
.lbh .lbh-tag-sub{display:none;font:700 10.5px/1.1 ${FONT_POP};letter-spacing:.01em}
.lbh .lbh-tag[data-full] .lbh-tag-sub{display:block}
.lbh .lbh-tag-tail{width:0;height:0;margin-top:-1px;border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid ${INK}}
.lbh .lbh-tag-dot{width:9px;height:9px;margin-top:0;background:var(--tc);border:2px solid ${INK};border-radius:99px !important}
.lbh .lbh-tag[data-kind="capital"]{--tc:${C.accent}}
.lbh .lbh-tag[data-kind="capital"] .lbh-tag-box{padding:4px 10px 5px 8px;box-shadow:3px 3px 0 ${INK}}
.lbh .lbh-tag[data-kind="capital"] .lbh-tag-name{font-size:15px;font-weight:900}
.lbh .lbh-tag[data-kind="city"]{--tc:${C.coral}}
.lbh .lbh-tag[data-kind="city"] .lbh-tag-name{font-size:13.5px}
.lbh .lbh-tag[data-kind="village"] .lbh-tag-name{font-size:11.5px}
.lbh .lbh-tag[data-kind="village"] .lbh-tag-box{padding:2px 7px 3px}
.lbh .lbh-tag[data-kind="harbour"]{--tc:${C.teal}}
.lbh .lbh-tag[data-kind="airport"]{--tc:${C.sky}}
.lbh .lbh-tag[data-kind="landmark"]{--tc:${C.lilac}}
.lbh .lbh-tag[data-kind="landmark"] .lbh-tag-name{font-size:11px}
.lbh .lbh-tag[data-kind="station"]{--tc:${C.lilac}}
.lbh .lbh-tag[data-kind="station"] .lbh-tag-dot{animation:lbh-ping 1.6s ease-out infinite}
.lbh .lbh-tag[data-track] .lbh-tag-box::after{content:'ride';margin-left:2px;font:800 10.5px/1 ${FONT_POP};letter-spacing:.06em;padding:2px 5px 3px;background:${INK};color:var(--tc);border-radius:5px !important}
.lbh .lbh-tag:disabled{cursor:default}
.lbh[data-compact] .lbh-tag-name{font-size:11.5px}
.lbh[data-compact] .lbh-tag[data-kind="capital"] .lbh-tag-name{font-size:13.5px}

/* Touch: every tag is a ≥ 40 px target (box, stem and dot), with a little more slop around it. */
.lbh[data-touch] .lbh-tag .lbh-tag-box{padding:6px 10px 7px;gap:6px}
.lbh[data-touch] .lbh-tag .lbh-tag-name{font-size:13px}
.lbh[data-touch] .lbh-tag[data-kind="capital"] .lbh-tag-name{font-size:14.5px}
.lbh[data-touch] .lbh-tag::before{inset:-6px -8px -4px}

/* ── hover tip ── */
.lbh .lbh-hover{position:absolute;left:0;top:0;display:flex;align-items:center;gap:7px;padding:4px 10px 5px 4px;white-space:nowrap;pointer-events:none;opacity:0;
  background:${C.paper};border:2px solid ${INK};border-radius:99px !important;box-shadow:3px 3px 0 ${INK};transition:opacity .12s;will-change:transform}
.lbh .lbh-hover[data-on]{opacity:1}
.lbh .lbh-hdot{display:grid;place-items:center;width:26px;height:26px;background:var(--kc);border:2px solid ${INK};border-radius:99px !important;--lbf:#fff}
.lbh .lbh-hover small{display:block;font:800 10.5px/1 ${FONT_POP};letter-spacing:.03em;color:rgba(27,21,48,.62);margin-bottom:2px}
.lbh .lbh-hover b{font-size:13px;font-weight:900;line-height:1}

/* Keep chrome in the safe area without moving the world-label coordinate system. */
.lbh[data-variant="page"]{--safe-top:env(safe-area-inset-top,0px);--safe-right:env(safe-area-inset-right,0px);--safe-bottom:env(safe-area-inset-bottom,0px);--safe-left:env(safe-area-inset-left,0px)}
.lbh[data-variant="page"] .lbh-tl{top:calc(64px + var(--safe-top));left:calc(10px + var(--safe-left))}
.lbh[data-variant="page"] .lbh-time{top:calc(12px + var(--safe-top));right:calc(12px + var(--safe-right))}
.lbh[data-variant="page"]:not([data-rail]) .lbh-dock,.lbh[data-variant="page"][data-stick] .lbh-dock,.lbh[data-variant="page"][data-squat] .lbh-dock{bottom:calc(14px + var(--safe-bottom))}
.lbh[data-variant="page"][data-rail] .lbh-dock,.lbh[data-variant="page"][data-stick] .lbh-dock{right:calc(14px + var(--safe-right))}
.lbh[data-variant="page"][data-rail][data-short]:not([data-squat]):not([data-stick]) .lbh-dock{top:calc(64px + var(--safe-top))}
.lbh[data-squat][data-rail] .lbh-dock{top:auto;transform:none;border-radius:20px !important}
.lbh[data-touch][data-compact] .lbh-dock{padding-bottom:23px}
.lbh[data-squat][data-compact] .lbh-tl{right:calc(132px + var(--safe-right,0px))}
.lbh[data-touch] .lbh-x{width:44px;height:44px}
.lbh[data-touch] button:not(.lbh-tag){min-width:44px;min-height:44px}

@keyframes lbh-pop{0%{opacity:0;transform:scale(.7) rotate(-3deg)}60%{opacity:1;transform:scale(1.04) rotate(.6deg)}100%{transform:scale(1) rotate(0)}}
@keyframes lbh-pop-c{0%{opacity:0;transform:translateX(-50%) scale(.6)}60%{opacity:1;transform:translateX(-50%) scale(1.05)}100%{transform:translateX(-50%) scale(1)}}
@keyframes lbh-pop-r{0%{opacity:0;transform:translateY(-50%) scale(.6)}60%{opacity:1;transform:translateY(-50%) scale(1.05)}100%{transform:translateY(-50%) scale(1)}}
@keyframes lbh-out{to{opacity:0;transform:scale(.82) translateY(-8px) rotate(-2deg)}}
@keyframes lbh-burst{to{transform:rotate(360deg)}}
@keyframes lbh-spin{to{transform:rotate(360deg)}}
@keyframes lbh-blink{to{visibility:hidden}}
@keyframes lbh-ping{0%{box-shadow:0 0 0 0 rgba(169,156,218,.9)}100%{box-shadow:0 0 0 9px rgba(169,156,218,0)}}

/* Reduced motion: no springs, no spinning, no pops (state changes still show, instantly). Shot mode
   too: review frames are deterministic. */
.lbh[data-rm] *,.lbh[data-rm] *::before,.lbh[data-rm] *::after,.lbh[data-shot] *,.lbh[data-shot] *::before,.lbh[data-shot] *::after{animation:none !important;transition:none !important}
`;
