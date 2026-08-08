// Changing the brand kit re-applies its heading font (fonts[0]) to ALL
// text, everywhere: body copy follows the headline, and so do
// author-added boxes. fonts[1] reaches nothing — the only text a creative
// can hold is headline + body (auto-layout strips the rest).

import { describe, expect, it } from "vitest";
import { applyBrandKitFontsToText, initialState } from "../src/state";
import type { BrandKit } from "../src/brand-kit";
import type { LayoutItem, Page } from "../src/types";

const txt = (field: string, font: string): LayoutItem =>
  ({ type: "text", field, fontFamily: font }) as LayoutItem;
const fontOf = (items: LayoutItem[], field: string): unknown =>
  (items.find((i) => (i as { field?: string }).field === field) as unknown as Record<string, unknown>).fontFamily;
const kit: BrandKit = { name: "", colors: [], fonts: ["BrandHead", "BrandBody"] };

describe("applyBrandKitFontsToText", () => {
  it("gives every reader-surface text the heading font, headline included", () => {
    const pages: Page[] = [{
      layout: [txt("headline", "Old"), txt("body", "Old"), txt("sub", "Old")],
      banners: { "mobile-expanded": [txt("headline", "Old"), txt("body", "Old")] },
    }] as Page[];
    const out = applyBrandKitFontsToText(initialState(pages, "expanded"), kit);
    const L = out.pages[0]!.layout!;
    expect(fontOf(L, "headline")).toBe("BrandHead");
    expect(fontOf(L, "body")).toBe("BrandHead");
    expect(fontOf(L, "sub")).toBe("BrandHead");
    const M = out.pages[0]!.banners!["mobile-expanded"]!;
    expect(fontOf(M, "body")).toBe("BrandHead");
  });

  it("uses the heading font in collapsed buckets too, never fonts[1]", () => {
    // A legacy `tag` item (predating auto-layout's strip filter) and an
    // author-added box with no field are both copy — one face.
    const pages: Page[] = [{
      layout: [txt("headline", "Old")],
      banners: {
        "300x250": [txt("headline", "Old"), txt("tag", "Old"), { type: "text", fontFamily: "Old" } as LayoutItem],
      },
    }] as Page[];
    const out = applyBrandKitFontsToText(initialState(pages, "expanded"), kit);
    const B = out.pages[0]!.banners!["300x250"]!;
    expect(fontOf(B, "headline")).toBe("BrandHead");
    expect(fontOf(B, "tag")).toBe("BrandHead");
    expect(B.every((i) => (i as { fontFamily?: string }).fontFamily !== "BrandBody")).toBe(true);
  });

  it("is an idempotent fixpoint once applied", () => {
    const pages: Page[] = [{
      layout: [txt("headline", "BrandHead"), txt("body", "BrandHead")],
      banners: { "300x250": [txt("headline", "BrandHead"), txt("tag", "BrandHead")] },
    }] as Page[];
    const s = initialState(pages, "expanded");
    expect(applyBrandKitFontsToText(s, kit)).toBe(s);
  });

  it("falls back to Georgia with an empty kit, body included", () => {
    const pages: Page[] = [{ layout: [txt("headline", "X"), txt("body", "Y")] }] as Page[];
    const out = applyBrandKitFontsToText(initialState(pages, "expanded"), { name: "", colors: [], fonts: [] });
    expect(fontOf(out.pages[0]!.layout!, "headline")).toBe("Georgia");
    expect(fontOf(out.pages[0]!.layout!, "body")).toBe("Georgia");
  });
});
