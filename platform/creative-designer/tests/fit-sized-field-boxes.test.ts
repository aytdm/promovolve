import { describe, expect, it } from "vitest";
import { fitSizedFieldBoxes, initialState } from "../src/state";
import type { LayoutItem, Page } from "../src/types";

// The bucket counterpart of fitReaderFieldBoxes: after a synced field
// edit, every IAB bucket's same-field box is re-fit to the text it now
// renders. The DOM measuring lives in render/canvas; here the callback
// is stubbed, and the contract under test is the STAMPING — which items
// are touched, which axis anchors hold, and referential no-ops.

const text = (over: Record<string, unknown> = {}): LayoutItem =>
  ({ type: "text", field: "headline", left: 10, top: 5, width: 50, height: 40, ...over } as LayoutItem);

const mk = (buckets: Record<string, LayoutItem[]>): Page[] => [
  { headline: "COPY", layout: [text()], banners: { "mobile-expanded": [text()], ...buckets } } as Page,
];

const bucketItem = (s: ReturnType<typeof fitSizedFieldBoxes>, key: string): Record<string, unknown> =>
  s.pages[0].banners![key]![0] as unknown as Record<string, unknown>;

describe("fitSizedFieldBoxes", () => {
  it("stamps width+height on a horizontal bucket item, keeping left/top", () => {
    const st = initialState(mk({ "300x250": [text()] }), "mobile");
    const r = fitSizedFieldBoxes(st, "headline", () => ({ width: 30, height: 12 }));
    const it = bucketItem(r, "300x250");
    expect(it.width).toBe(30);
    expect(it.height).toBe(12);
    expect(it.left).toBe(10);
    expect(it.top).toBe(5);
  });

  it("keeps the RIGHT edge fixed for vertical-rl (left derives from the packed width)", () => {
    const st = initialState(mk({ "300x600": [text({ writingMode: "vertical-rl" })] }), "mobile");
    const r = fitSizedFieldBoxes(st, "headline", () => ({ width: 15, height: 20 }));
    const it = bucketItem(r, "300x600");
    // right edge was 10 + 50 = 60; packed width 15 → left 45
    expect(it.width).toBe(15);
    expect(it.left).toBe(45);
    expect(it.top).toBe(5);
    expect(it.height).toBe(20);
  });

  it("leaves the mobile-expanded reader surface alone (fitReaderFieldBoxes owns it)", () => {
    const st = initialState(mk({ "300x250": [text()] }), "mobile");
    const r = fitSizedFieldBoxes(st, "headline", () => ({ width: 30, height: 12 }));
    expect(r.pages[0].banners!["mobile-expanded"]).toBe(st.pages[0].banners!["mobile-expanded"]);
  });

  it("measures a detached override against its OWN text", () => {
    const st = initialState(mk({ "300x250": [text({ text: "LOCAL" })] }), "mobile");
    const seen: string[] = [];
    fitSizedFieldBoxes(st, "headline", (t) => { seen.push(t); return null; });
    expect(seen).toEqual(["LOCAL"]);
  });

  it("returns the SAME state when every measure is a no-op", () => {
    const st = initialState(mk({ "300x250": [text()] }), "mobile");
    // measure returns the current extents → nothing to stamp
    expect(fitSizedFieldBoxes(st, "headline", () => ({ width: 50, height: 40 }))).toBe(st);
    // …and when the callback declines to measure
    expect(fitSizedFieldBoxes(st, "headline", () => null)).toBe(st);
  });

  it("only touches items bound to the edited field", () => {
    const st = initialState(
      mk({ "300x250": [text(), text({ field: "body", width: 33 })] }), "mobile");
    const r = fitSizedFieldBoxes(st, "headline", () => ({ width: 30, height: 12 }));
    const body = r.pages[0].banners!["300x250"]![1] as unknown as Record<string, unknown>;
    expect(body.width).toBe(33);
    expect(body.height).toBe(40);
  });
});
