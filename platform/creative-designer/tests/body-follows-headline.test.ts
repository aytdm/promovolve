// Reader copy is set in the HEADLINE's face, not the brand kit's second
// font (user decision 2026-08-08). The kit's body font stays in service
// for collapsed-unit chrome — the tag eyebrow and the "Read More" CTA.

import { describe, expect, it } from "vitest";
import { presetLayoutFor } from "../src/presets";
import type { BrandKit } from "../src/brand-kit";
import type { LayoutItem, Page } from "../src/types";

const kit: BrandKit = { name: "", colors: [], fonts: ["BrandHead", "BrandBody"] };

const page = (): Page => ({
  headline: "Headline",
  sub: "Sub",
  body: "Body copy",
  tag: "TAG",
} as Page);

const byField = (items: LayoutItem[], field: string): Record<string, unknown> =>
  items.find((i) => (i as { field?: string }).field === field) as unknown as Record<string, unknown>;
const byText = (items: LayoutItem[], text: string): Record<string, unknown> =>
  items.find((i) => (i as { text?: string }).text === text) as unknown as Record<string, unknown>;

describe("body follows headline", () => {
  it.each(["expanded", "mobile"])("%s: body takes the headline's face", (mode) => {
    const items = presetLayoutFor(mode, page(), kit)!;
    expect(byField(items, "headline").fontFamily).toBe("BrandHead");
    expect(byField(items, "body").fontFamily).toBe("BrandHead");
  });

  it("an authored body face still wins over the headline's", () => {
    // The wide master is the font source of truth the expanded presets
    // read from, so a hand-set body face there must survive a regenerate.
    const p = {
      ...page(),
      layout: [
        { type: "text", field: "headline", fontFamily: "AuthoredHead" },
        { type: "text", field: "body", fontFamily: "AuthoredBody" },
      ] as LayoutItem[],
    } as Page;
    const items = presetLayoutFor("expanded", p, kit)!;
    expect(byField(items, "headline").fontFamily).toBe("AuthoredHead");
    expect(byField(items, "body").fontFamily).toBe("AuthoredBody");
  });

  it("body follows an authored headline when body itself is unset", () => {
    const p = {
      ...page(),
      layout: [{ type: "text", field: "headline", fontFamily: "AuthoredHead" }] as LayoutItem[],
    } as Page;
    const items = presetLayoutFor("mobile", p, kit)!;
    expect(byField(items, "body").fontFamily).toBe("AuthoredHead");
  });

  it("collapsed units: the headline takes the heading face", () => {
    const items = presetLayoutFor("300x250", page(), kit)!;
    expect(byField(items, "headline").fontFamily).toBe("BrandHead");
  });
});

// auto-layout's applyLayout keeps only text bound to `headline`/`body`
// and drops the rest ("the whole sheet is the link" — there is no CTA to
// wire, and the tag is internal metadata). A preset that composes items
// outside that set is doing work the pipeline throws away, which is how
// the tag eyebrow, the `sub` line and the "Read More" CTA sat in here
// unrendered until 2026-08-08. Every preset is checked, with a page that
// supplies every field, so a re-added item can't hide behind a falsy one.
describe("presets emit only what a creative can hold", () => {
  const MODES = ["expanded", "mobile", "300x250", "336x280", "970x250", "728x90",
                 "970x90", "320x50", "320x100", "160x600", "300x600"];

  it.each(MODES)("%s", (mode) => {
    const items = presetLayoutFor(mode, { ...page(), img: "https://cdn/x.png" } as Page, kit)!;
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      if (it.type !== "text") continue;
      const t = it as unknown as { field?: string; text?: string };
      expect(["headline", "body"], `${mode} emits ${t.field ?? JSON.stringify(t.text)}`)
        .toContain(t.field);
    }
    expect(byText(items, "Read More")).toBeUndefined();
  });
});
