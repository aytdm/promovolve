import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pickCollapsedLayout } from "@banner/utils";
import { MODES } from "../src/modes";
import type { LayoutItem } from "../src/types";

// The WordPress plugin's size menu is the publisher-facing list of
// shapes real inventory can declare by name, so it's the floor for what
// the designer must let an author compose for. Read straight from the
// plugin source rather than restated here: a size added to the block
// editor should fail this test until the designer has a bucket whose
// aspect matches it, instead of silently shipping squeezed creatives.
//
// The plugin ships as a no-build ES5 folder, so there's nothing to
// import — the SIZES array is scraped from the source text.
const EDITOR_JS = fileURLToPath(
  new URL("../../../integrations/wordpress/promovolve/blocks/slot/editor.js", import.meta.url),
);

function pluginSizes(): Array<{ w: number; h: number }> {
  const src = readFileSync(EDITOR_JS, "utf8");
  const block = src.match(/var SIZES = \[([\s\S]*?)\];/);
  if (!block) throw new Error("SIZES array not found in the plugin's editor.js");
  const out: Array<{ w: number; h: number }> = [];
  for (const m of block[1]!.matchAll(/\{\s*w:\s*(\d+),\s*h:\s*(\d+)/g)) {
    out.push({ w: Number(m[1]), h: Number(m[2]) });
  }
  return out;
}

const item = (): LayoutItem =>
  ({ type: "rect", left: 0, top: 0, width: 10, height: 10, fill: "#000" } as LayoutItem);

/** A fully fanned-out creative: every authorable bucket populated. */
function authoredBanners(): Record<string, LayoutItem[]> {
  const banners: Record<string, LayoutItem[]> = {};
  for (const m of MODES) {
    if (m.sizeKey) banners[m.sizeKey] = [item()];
  }
  return banners;
}

describe("WordPress named sizes are all authorable", () => {
  const sizes = pluginSizes();

  it("scrapes the plugin's size menu", () => {
    expect(sizes.length).toBeGreaterThan(0);
  });

  it.each(sizes)("$w×$h resolves to a bucket of the same aspect", ({ w, h }) => {
    // Distance 0 on pickCollapsedLayout's log-aspect metric — i.e. an
    // authored layout composed for exactly this shape, not stretched
    // out of a neighbouring one. 336×280 satisfies this via the 6:5
    // 300x250 bucket (identical aspect); it needs no bucket of its own.
    const picked = pickCollapsedLayout(authoredBanners(), w, h);
    expect(picked, `no bucket for ${w}x${h}`).not.toBeNull();
    const [bw, bh] = picked!.key.split("x").map(Number);
    expect(bw! / bh!).toBeCloseTo(w / h, 10);
  });
});
