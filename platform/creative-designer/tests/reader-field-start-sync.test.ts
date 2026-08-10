// The START CORNER of a field-bound reader text item is shared across every
// page, from ANY page — same "whichever you edit wins" rule as size and face.
// Only the corner: each page keeps its own width/height, because the pages
// carry different copy and fitReaderFieldBoxes packs each box to its own text.
//
// The corner is NOT always top-left. vertical-rl stacks columns right-to-left
// from the top-RIGHT, and rtl horizontal runs from the right too, so the
// shared edge is the box's inline-START — the right edge in both those cases.
// A right-anchored follower derives its own left from ITS OWN width, which is
// what keeps the visible start aligned while the boxes differ in size.

import { describe, expect, it } from "vitest";
import { initialState, readerFieldStart, setReaderFieldStart, syncTypographyFromPage1 } from "../src/state";
import type { LayoutItem, Page } from "../src/types";

interface Box { left: number; top: number; width: number; height?: number }

const txt = (field: string, box: Box, extra: Record<string, unknown> = {}): LayoutItem =>
  ({ type: "text", field, fontSize: 5, fontFamily: "sans-serif", ...box, ...extra }) as LayoutItem;

// Three pages whose boxes differ in EXTENT (copy length differs) and in
// position — the state a start-sync has to converge.
const pages = (extra: Record<string, unknown> = {}): Page[] => [
  { layout: [txt("headline", { left: 10, top: 10, width: 40, height: 12 }, extra)],
    banners: { "mobile-expanded": [txt("headline", { left: 10, top: 10, width: 40 }, extra)],
      "300x250": [txt("headline", { left: 99, top: 99, width: 10 }, extra)] } },
  { layout: [txt("headline", { left: 30, top: 50, width: 25, height: 20 }, extra)],
    banners: { "mobile-expanded": [txt("headline", { left: 30, top: 50, width: 25 }, extra)] } },
  { layout: [txt("headline", { left: 70, top: 80, width: 55, height: 8 }, extra)],
    banners: { "mobile-expanded": [txt("headline", { left: 70, top: 80, width: 55 }, extra)] } },
] as Page[];

const box = (p: Page, surface: "layout" | "mobile-expanded"): LayoutItem & Box => {
  const items = surface === "layout" ? p.layout! : p.banners!["mobile-expanded"]!;
  return items[0] as unknown as LayoutItem & Box;
};

describe("readerFieldStart", () => {
  it("reads the LEFT edge for ordinary horizontal text", () => {
    expect(readerFieldStart(txt("headline", { left: 12, top: 30, width: 40 })))
      .toEqual({ top: 30, side: "left", pct: 12 });
  });

  it("reads the RIGHT edge for vertical-rl — columns start there", () => {
    expect(readerFieldStart(txt("headline", { left: 12, top: 30, width: 40 }, { writingMode: "vertical-rl" })))
      .toEqual({ top: 30, side: "right", pct: 52 });
  });

  it("reads the RIGHT edge for rtl horizontal text too", () => {
    expect(readerFieldStart(txt("headline", { left: 12, top: 30, width: 40 }, { direction: "rtl" })))
      .toEqual({ top: 30, side: "right", pct: 52 });
  });

  it("is null for anything that is not text", () => {
    expect(readerFieldStart({ type: "image", left: 1, top: 2 } as LayoutItem)).toBeNull();
  });
});

describe("setReaderFieldStart — horizontal", () => {
  it("puts every page's box at the same left/top, on both reader surfaces", () => {
    const src = box(pages()[1]!, "layout");
    const out = setReaderFieldStart(initialState(pages(), "expanded"), "headline", readerFieldStart(src)!);
    for (const pi of [0, 1, 2]) {
      for (const surf of ["layout", "mobile-expanded"] as const) {
        expect(box(out.pages[pi]!, surf).left).toBe(30);
        expect(box(out.pages[pi]!, surf).top).toBe(50);
      }
    }
  });

  it("leaves each page's own extent alone — only the corner is shared", () => {
    const out = setReaderFieldStart(initialState(pages(), "expanded"), "headline",
      { top: 50, side: "left", pct: 30 });
    expect(box(out.pages[0]!, "layout").width).toBe(40);
    expect(box(out.pages[1]!, "layout").width).toBe(25);
    expect(box(out.pages[2]!, "layout").width).toBe(55);
    expect(box(out.pages[0]!, "layout").height).toBe(12);
    expect(box(out.pages[2]!, "layout").height).toBe(8);
  });

  it("does not touch banner buckets — they are single-page ads", () => {
    const out = setReaderFieldStart(initialState(pages(), "expanded"), "headline",
      { top: 50, side: "left", pct: 30 });
    const bucket = out.pages[0]!.banners!["300x250"]![0] as unknown as Box;
    expect(bucket.left).toBe(99);
    expect(bucket.top).toBe(99);
  });
});

describe("setReaderFieldStart — right-anchored", () => {
  it("aligns the RIGHT edge, so each page derives its own left from its own width", () => {
    const vertical = { writingMode: "vertical-rl" };
    const out = setReaderFieldStart(initialState(pages(vertical), "expanded"), "headline",
      { top: 20, side: "right", pct: 80 });
    // Same right edge everywhere; lefts differ exactly by the widths.
    expect(box(out.pages[0]!, "layout").left).toBe(40); // 80 - 40
    expect(box(out.pages[1]!, "layout").left).toBe(55); // 80 - 25
    expect(box(out.pages[2]!, "layout").left).toBe(25); // 80 - 55
    for (const pi of [0, 1, 2]) {
      const b = box(out.pages[pi]!, "layout");
      expect(b.left + b.width).toBe(80);
      expect(b.top).toBe(20);
    }
  });

  it("holds the shared start even when a follower's box overflows past it", () => {
    // page 3's box is 55 wide, so a right edge at 20 puts its left at -35.
    // It overflows and gets clipped — visible, and the author's to fix.
    // Nudging it back on stage would silently break the alignment, which is
    // the one thing this function promises.
    const out = setReaderFieldStart(initialState(pages({ writingMode: "vertical-rl" }), "expanded"),
      "headline", { top: 0, side: "right", pct: 20 });
    expect(box(out.pages[2]!, "layout").left).toBe(-35);
    for (const pi of [0, 1, 2]) {
      const b = box(out.pages[pi]!, "layout");
      expect(b.left + b.width).toBe(20);
    }
  });
});

describe("setReaderFieldStart — convergence", () => {
  it("returns the SAME state object when nothing moves (fixpoint)", () => {
    const state = setReaderFieldStart(initialState(pages(), "expanded"), "headline",
      { top: 50, side: "left", pct: 30 });
    expect(setReaderFieldStart(state, "headline", { top: 50, side: "left", pct: 30 })).toBe(state);
  });

  it("survives the page-1-master subscriber — it must not drag positions back", () => {
    // The subscriber syncs size/face/writing FROM page 1. Position is not in
    // its key set, so a start edited on page 3 must still stand afterwards.
    const start = readerFieldStart(box(pages()[2]!, "layout"))!;
    const synced = setReaderFieldStart(initialState(pages(), "expanded"), "headline", start);
    const after = syncTypographyFromPage1(synced);
    for (const pi of [0, 1, 2]) {
      expect(box(after.pages[pi]!, "layout").left).toBe(70);
      expect(box(after.pages[pi]!, "layout").top).toBe(80);
    }
  });

  it("ignores other fields and field-less text", () => {
    const mixed = [
      { layout: [txt("headline", { left: 10, top: 10, width: 40 }), txt("body", { left: 5, top: 60, width: 30 })] },
      { layout: [txt("headline", { left: 90, top: 90, width: 40 }), txt("body", { left: 5, top: 60, width: 30 })] },
    ] as Page[];
    const out = setReaderFieldStart(initialState(mixed, "expanded"), "headline",
      { top: 10, side: "left", pct: 10 });
    expect(box(out.pages[1]!, "layout").left).toBe(10);
    expect((out.pages[1]!.layout![1] as unknown as Box).left).toBe(5);
    expect((out.pages[1]!.layout![1] as unknown as Box).top).toBe(60);
  });

  it("rejects nonsense starts", () => {
    const state = initialState(pages(), "expanded");
    expect(setReaderFieldStart(state, "headline", { top: NaN, side: "left", pct: 10 })).toBe(state);
    expect(setReaderFieldStart(state, "", { top: 1, side: "left", pct: 10 })).toBe(state);
    // Off-stage starts are refused outright rather than clamped: a clamp
    // would move every page to a position the author never chose.
    expect(setReaderFieldStart(state, "headline", { top: -5, side: "left", pct: 10 })).toBe(state);
    expect(setReaderFieldStart(state, "headline", { top: 10, side: "left", pct: 140 })).toBe(state);
  });
});
