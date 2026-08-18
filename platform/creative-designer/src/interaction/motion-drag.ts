// Drag the motion-ghost of an item to edit its animationTo position.
// Mirrors interaction/drag.ts but writes into item.animationTo instead
// of item.left/top.

import { clientToPct, type Rect } from "../coords";
import { clamp } from "../math";
import { currentLayout, setSelection, updateItem } from "../state";
import type { Store } from "../store";

interface MotionDragParams {
  e: PointerEvent;
  idx: number;
  store: Store;
  canvasRect: () => Rect;
}

export function startMotionDrag({ e, idx, store, canvasRect }: MotionDragParams): void {
  const item = currentLayout(store.state)[idx];
  if (!item) return;
  const to = item.animationTo;
  if (!to) return;
  e.preventDefault();
  e.stopPropagation();

  const start = clientToPct(canvasRect(), e.clientX, e.clientY);
  const origLeft = to.left ?? item.left ?? 0;
  const origTop = to.top ?? item.top ?? 0;
  const stateAtStart = store.state;
  const downX = e.clientX;
  const downY = e.clientY;
  let moved = false;

  const onMove = (ev: PointerEvent): void => {
    // 4px slop before the gesture owns the pointer as a DRAG. Below it,
    // this is a CLICK — and a click on the ghost must fall through to
    // whatever sits beneath (see onEnd): the ghost is a large invisible-
    // purpose overlay that parked itself over other items and swallowed
    // every attempt to select them or deselect ("I need deselect in
    // layers to fix it", 2026-08-18).
    if (!moved && Math.hypot(ev.clientX - downX, ev.clientY - downY) <= 4) return;
    moved = true;
    const p = clientToPct(canvasRect(), ev.clientX, ev.clientY);
    const nextLeft = clamp(round1(origLeft + (p.x - start.x)), -50, 150);
    const nextTop = clamp(round1(origTop + (p.y - start.y)), -50, 150);
    const next = updateItem(store.state, idx, (it) => ({
      ...it,
      animationTo: { ...(it.animationTo ?? {}), left: nextLeft, top: nextTop },
    }));
    store.replace(next);
  };

  const onEnd = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onEnd);
    window.removeEventListener("blur", onEnd);
    const before = currentLayout(stateAtStart)[idx]?.animationTo;
    const after = currentLayout(store.state)[idx]?.animationTo;
    if (before?.left !== after?.left || before?.top !== after?.top) {
      store.commit(store.state);
    }
  };

  const onUp = (ev: PointerEvent): void => {
    onEnd();
    if (moved) return;
    // Click, not drag: hand the click to what's UNDER the ghost — the
    // topmost item hitbox if any (select it), the bare canvas otherwise
    // (deselect). Without this the ghost trapped the whole area it
    // covered.
    const under = document.elementsFromPoint(ev.clientX, ev.clientY)
      .find((el) => (el as HTMLElement).dataset?.cdIdx !== undefined) as HTMLElement | undefined;
    if (under) {
      const i = Number(under.dataset.cdIdx);
      if (Number.isFinite(i)) {
        store.replace(setSelection(store.state, [i]));
        document.dispatchEvent(new CustomEvent("cd:component-selected"));
        return;
      }
    }
    store.replace(setSelection(store.state, []));
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onEnd);
  window.addEventListener("blur", onEnd);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
