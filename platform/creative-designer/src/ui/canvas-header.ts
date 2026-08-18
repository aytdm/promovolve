// 40px strip above the canvas. Acts as the per-banner menu bar:
//
//   Left:  mode label · pixel dims · status pill · divider ·
//          Regenerate this size
//   Right: the page pager (‹ Page n / total ›) — moved here from
//          menu-bar.ts, it's the only pager in the shell now.
//
// Per-size regenerate lives here (not in the top slim bar) because it
// applies to the banner currently on screen. "Regenerate all" stays in
// the top bar. (A cross-size "Duplicate to…"/"Copy from…" action lived
// here too; removed — after the aspect-bucket collapse every remaining
// mode pair differs in shape, so a verbatim percent-coordinate copy
// always produced a distorted composition, and fanout + Regenerate
// already cover "fill this cell".)
//
// The status pill is the "at a glance" cue that complements the
// size-matrix dot on the left rail: both colors come from the same
// fanoutStatus selector so authors see a consistent signal.

import { switchPage } from "../state";
import type { Store } from "../store";
import type { DesignerContext, DesignerState } from "../types";
import { regenerateCurrentMode } from "../auto-layout";
import { isMultiPage } from "../modes";
import { mountAlignToolbar } from "./align-toolbar";
import { mountHistoryButtons } from "./history-buttons";
import { mountDraftButton } from "./save";
import { mountToolbar } from "./toolbar";
import { tokens } from "./tokens";

export interface CanvasHeaderHandle {
  update(state: DesignerState): void;
}

export function mountCanvasHeader(host: HTMLElement, store: Store, ctx: DesignerContext): CanvasHeaderHandle {
  const bar = document.createElement("div");
  bar.className = "cd-canvas-header";
  bar.style.cssText = [
    // Wraps instead of overflowing: the full strip needs ~1030px, and
    // anything past the centre column's width used to render UNDER
    // the sidebar (the pager/cover/CTA cluster ghosting through the
    // Properties panel). When tight, the right cluster drops to a
    // second row and the canvas yields the ~40px — never an overlap.
    // FIXED 48 + 1px border = 49 on the shared pre-zoom grid: menu-bar
    // 39 + size-strip 89 + 49 = 177 = menu-bar 39 + tab-bar 36 + 3 x 34
    // collapsed sidebar rows — the bottom border MEETS the sidebar's
    // section boundary across the vertical divider instead of missing
    // it by a pixel (2026-08-18). Fixed height retires the wrap-to-a-
    // second-row insurance; the 1024 size gate already floors the width.
    // 48.6667 (146/3), not an integer — the compensation the zoom model
    // demands. Measured behavior of zoom:1.2 chrome hosts: content
    // heights scale exactly x1.2, but every 1px border SNAPS to exactly
    // 1 rendered px. The junction that must meet (this bar's bottom
    // border vs the sidebar's collapsed-section boundary) crosses THREE
    // borders on this side (menu, strip, this bar) and FIVE on the
    // sidebar side (menu, tab bar, 3 group rows) — so integer grids are
    // unsolvable: (Lcontent - Rcontent) x 1.2 must equal the 2-border
    // difference. Left content 39+89+48.6667 x 1.2 + 3 = 215 = right
    // content (39+34+3x34) x 1.2 + 5. Verified at dpr 1 and 2.
    "height: 48.6667px",
    // NOWRAP: the fixed height (pixel-grid junction below) clips a
    // wrapped second row — at 911px it bled over the canvas
    // (2026-08-18). Overflow is handled by the priority demotion into
    // the ⋯ popover instead: clusters leave the bar for the popover
    // narrowest-first, so the row NEVER exceeds its width.
    "flex-wrap: nowrap",
    "padding: 0 12px",
    "display: flex",
    "align-items: center",
    "gap: 6px",
    `background: ${tokens.ink800}`,
    `border-bottom: 1px solid ${tokens.ink500}`,
    "flex: 0 0 auto",
    "position: relative",
  ].join(";");

  // Responsive priority-overflow (the size gate admits widths down to
  // 760px, far below the bar's natural ~760px of chrome): every cluster
  // after the tool group lives in a WRAPPER that can demote into the ⋯
  // popover when the row would overflow, narrowest-priority first —
  // align/pack, then undo/redo, then Regenerate, then Save draft. The
  // tool group and the pager never leave the bar.
  const cluster = (): HTMLElement => {
    const c = document.createElement("div");
    c.style.cssText = "display:flex;align-items:center;gap:6px;flex:0 0 auto;";
    return c;
  };

  // Tool group (select / text / image / rect / circle / trash) —
  // lives at the far left of the header, followed by a divider
  // separating it from the banner identity cluster. Wrapped so it can
  // demote LAST: at the 760px gate floor even a fully-demoted bar
  // overflowed by ~96px — the icons themselves are the final tier.
  const wTools = cluster();
  mountToolbar(wTools, store);
  wTools.appendChild(verticalDivider());
  bar.appendChild(wTools);

  // Save draft lives HERE with the editing tools — deliberately far from
  // Publish (menu bar): the two were adjacent icon buttons once and a
  // mis-tap published a creative with no confirmation.
  const wSave = cluster();
  mountDraftButton(wSave, store, ctx);
  wSave.appendChild(verticalDivider());
  bar.appendChild(wSave);

  // Undo / redo — editing actions live with the tools (moved here
  // from the menu bar, which keeps identity + preview/save/publish).
  const wHistory = cluster();
  mountHistoryButtons(wHistory, store);
  wHistory.appendChild(verticalDivider());
  bar.appendChild(wHistory);

  // Alignment + distribution group. Always visible; buttons disable
  // themselves when the selection isn't large enough to act on.
  const wAlign = cluster();
  mountAlignToolbar(wAlign, store);
  wAlign.appendChild(verticalDivider());
  bar.appendChild(wAlign);

  // (No mode label or status pill here: the active size-matrix chip
  // already names the mode and carries the SAME fanoutStatus dot —
  // the header duplicates were dropped to keep the strip one row.)

  // Per-banner regenerate. Fresh Gemini call (rewrite-copy +
  // generate-layout) for expanded/mobile, deterministic preset for
  // IAB sized modes. Overwrites whatever's currently in the cell — the
  // user can Cmd+Z to restore the previous draft.
  //
  // The mode name rides as a muted label on the RIGHT of the button —
  // it answers "regenerate WHAT?" right where the question arises
  // (e.g. a sized tab showing the canvas's 'Creative missing layout'
  // placeholder). This is the mode identity's only home in the header;
  // the matrix chips carry the dims + status dot.
  const modeTag = document.createElement("span");
  modeTag.style.cssText = [
    `color: ${tokens.ink300}`,
    "font-size: 11px",
    "white-space: nowrap",
  ].join(";");
  const regenBtn = ghostBtn(ICON_SPARKLE, "Regenerate", "Regenerate this size", () => {
    void regenerateCurrentMode(store).catch((e) => console.error("[canvas-header] regenerate failed", e));
  });
  const wRegen = cluster();
  wRegen.append(regenBtn, modeTag);
  bar.appendChild(wRegen);

  // Spacer pushes pager to the right.
  const spacer = document.createElement("div");
  spacer.style.flex = "1";
  spacer.style.minWidth = "0";
  bar.appendChild(spacer);

  // ⋯ overflow button + popover hosting demoted clusters. Hidden while
  // everything fits. The popover stacks clusters vertically in demotion
  // order; each keeps its own horizontal layout (trailing divider hidden
  // there via the wrapper class).
  const moreBtn = ghostBtn(ICON_MORE, "", "More tools", () => {
    popover.style.display = popover.style.display === "none" ? "flex" : "none";
  });
  moreBtn.style.display = "none";
  const popover = document.createElement("div");
  popover.style.cssText = [
    "position: absolute",
    "top: 100%",
    "right: 8px",
    "z-index: 60",
    "display: none",
    "flex-direction: column",
    "gap: 8px",
    "padding: 10px",
    `background: ${tokens.ink800}`,
    `border: 1px solid ${tokens.ink500}`,
    "border-radius: 6px",
    "box-shadow: 0 8px 24px rgba(0,0,0,0.35)",
  ].join(";");
  document.addEventListener("pointerdown", (e) => {
    if (popover.style.display === "none") return;
    const t = e.target as Node;
    if (!popover.contains(t) && !moreBtn.contains(t)) popover.style.display = "none";
  });
  bar.append(moreBtn, popover);

  // Demotion engine: narrowest-priority-first list; measure, demote until
  // the row fits, promote back when space returns. rAF-batched so resize
  // streams settle in one pass; a settle-guard stops promote/demote
  // thrash at the boundary.
  const demotable = [wAlign, wHistory, wRegen, wSave, wTools];
  const demoted = new Set<HTMLElement>();
  const barSlots = new Map<HTMLElement, HTMLElement>(); // wrapper -> marker
  for (const w of demotable) {
    const marker = document.createElement("span");
    marker.style.display = "none";
    w.before(marker);
    barSlots.set(w, marker);
  }
  const fits = (): boolean => bar.scrollWidth <= bar.clientWidth + 1;
  let reflowQueued = false;
  const reflow = (): void => {
    if (reflowQueued) return;
    reflowQueued = true;
    requestAnimationFrame(() => {
      reflowQueued = false;
      // Promote everything back, then demote until it fits — one
      // deterministic pass, no oscillation.
      for (const w of [...demotable].reverse()) {
        if (demoted.has(w)) { barSlots.get(w)!.after(w); demoted.delete(w); }
      }
      for (const w of demotable) {
        if (fits()) break;
        popover.appendChild(w);
        demoted.add(w);
      }
      const any = demoted.size > 0;
      moreBtn.style.display = any ? "inline-flex" : "none";
      if (!any) popover.style.display = "none";
      // Hide each demoted cluster's trailing divider (last child) —
      // vertical stacking has no use for it; restore when promoted.
      for (const w of demotable) {
        const last = w.lastElementChild as HTMLElement | null;
        if (last && last.getAttribute("data-cd-divider") === "1") {
          last.style.display = demoted.has(w) ? "none" : "";
        }
      }
    });
  };
  new ResizeObserver(reflow).observe(bar);
  reflow();

  // Right cluster — pager
  const pager = document.createElement("div");
  pager.style.cssText = "display:flex;align-items:center;gap:6px;min-height:40px;";
  const prev = arrowBtn("‹", "Previous page");
  const pageLabel = document.createElement("span");
  pageLabel.style.cssText = [
    `color: ${tokens.ink200}`,
    `font-family: ${tokens.sans}`,
    "font-size: 11px",
    "min-width: 40px",
    "text-align: center",
    "font-variant-numeric: tabular-nums",
  ].join(";");
  const next = arrowBtn("›", "Next page");
  prev.addEventListener("click", () => {
    if (store.state.pageIdx > 0) store.replace(switchPage(store.state, store.state.pageIdx - 1));
  });
  next.addEventListener("click", () => {
    if (store.state.pageIdx < store.state.pages.length - 1) {
      store.replace(switchPage(store.state, store.state.pageIdx + 1));
    }
  });
  // (Cover picker removed with the CTA toggle: page 1 is the cover —
  // the editorial default the compose flow builds for. bannerConfig
  // .coverPageIdx stays in the schema, so creatives that chose another
  // cover before this keep rendering it.)
  pager.append(prev, pageLabel, next);
  bar.appendChild(pager);

  host.appendChild(bar);

  return {
    update(state) {
      // Short mode name (aspect parenthetical lives on the chips).
      const modeName = state.mode.label.replace(/\s*\(.*\)$/, "");
      modeTag.textContent = modeName;
      // Regenerate is an EXPANDED-mode action (the two-step Gemini copy
      // rewrite + layout). For IAB banner sizes it only ever re-applied
      // the deterministic preset — a reset in regenerate's clothing that
      // wiped any author layout in the bucket, and since generation-time
      // packing + tab-open self-heal (cc8b115) there is nothing left for
      // it to fix there. Disabled on sized tabs (user decision 2026-08-18).
      const regenEnabled = isMultiPage(state.mode);
      setEnabled(regenBtn, regenEnabled);
      regenBtn.title = regenEnabled
        ? `Regenerate ${modeName}`
        : "Regenerate works on the expanded pages — banner sizes follow them automatically";

      const total = state.pages.length;
      const current = state.pageIdx + 1;
      // Page nav applies in multi-page modes (Expanded PC + Expanded
      // Mobile) — IAB-sized modes are single-frame (cover only) so
      // pages 2/3 don't exist there.
      const pagerVisible = isMultiPage(state.mode);
      pager.style.display = pagerVisible ? "flex" : "none";
      pageLabel.textContent = total > 0 ? `${current} / ${total}` : "—"; // arrows make "page" self-evident
      setEnabled(prev, state.pageIdx > 0);
      setEnabled(next, state.pageIdx < total - 1);

    },
  };
}


// ─── Button builders ──────────────────────────────────────────────

function ghostBtn(iconSvg: string, label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = `${iconSvg}<span>${label}</span>`;
  b.style.cssText = [
    "display: inline-flex",
    "align-items: center",
    "gap: 5px",
    "padding: 4px 9px",
    "background: transparent",
    `color: ${tokens.ink200}`,
    `border: 1px solid ${tokens.ink500}`,
    "border-radius: 4px",
    "cursor: pointer",
    "font: inherit",
    "font-size: 11px",
    "white-space: nowrap",
    "transition: background .12s, color .12s, border-color .12s",
  ].join(";");
  b.addEventListener("mouseenter", () => {
    if (!b.disabled) {
      b.style.background = tokens.ink700;
      b.style.color = tokens.ink100;
    }
  });
  b.addEventListener("mouseleave", () => {
    if (!b.disabled) {
      b.style.background = "transparent";
      b.style.color = tokens.ink200;
    }
  });
  b.addEventListener("click", onClick);
  return b;
}

function verticalDivider(): HTMLElement {
  // (data-cd-divider lets the overflow engine hide a cluster's trailing
  // divider while the cluster is stacked in the popover.)
  const el = document.createElement("div");
  el.setAttribute("data-cd-divider", "1");
  el.style.cssText = `width: 1px; height: 20px; background: ${tokens.ink500}; margin: 0 2px;`;
  return el;
}

function arrowBtn(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.style.cssText = [
    "width: 24px",
    "height: 24px",
    "display: flex",
    "align-items: center",
    "justify-content: center",
    "background: transparent",
    `color: ${tokens.ink300}`,
    `border: 1px solid ${tokens.ink500}`,
    "border-radius: 4px",
    "font: inherit",
    "font-size: 14px",
    "cursor: pointer",
    "padding: 0",
    "transition: color .12s, border-color .12s",
  ].join(";");
  b.addEventListener("mouseenter", () => { if (!b.disabled) b.style.color = tokens.ink100; });
  b.addEventListener("mouseleave", () => { if (!b.disabled) b.style.color = tokens.ink300; });
  return b;
}

function setEnabled(btn: HTMLButtonElement, enabled: boolean): void {
  btn.disabled = !enabled;
  btn.style.opacity = enabled ? "1" : "0.35";
  btn.style.cursor = enabled ? "pointer" : "default";
}

// ─── Icon SVGs ────────────────────────────────────────────────────

const ICON_MORE = `<svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="11.5" cy="7" r="1.3"/></svg>`;
const ICON_SPARKLE = `<svg viewBox="0 0 14 14" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M7 1l1.2 3.3L11.5 5.5 8.2 6.7 7 10 5.8 6.7 2.5 5.5l3.3-1.2L7 1z"/><path d="M11 9l.5 1.4L13 11l-1.5.5L11 13l-.5-1.5L9 11l1.5-.5L11 9z"/></svg>`;
