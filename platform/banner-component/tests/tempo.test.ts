// Tempo multiplies durations: 1.0 = natural, larger = slower/statelier.
// The per-creative override floors at 1.0 (never faster than natural);
// the paper stocks' curated presets bypass the clamp (light = 0.8).
import { describe, expect, it } from "vitest";
import { TEMPO_MAX, TEMPO_MIN, dealTempo } from "../src/types";

const base = { layout: "auto", font: "sans", showTag: true, showSub: true } as const;

describe("dealTempo", () => {
  it("override clamps to [1.0, TEMPO_MAX]", () => {
    expect(TEMPO_MIN).toBe(1.0);
    expect(dealTempo({ ...base, tempo: 0.4 })).toBe(1.0);
    expect(dealTempo({ ...base, tempo: 1.7 })).toBe(1.7);
    expect(dealTempo({ ...base, tempo: 99 })).toBe(TEMPO_MAX);
  });

  it("unset follows the stock preset UNCLAMPED — light paper keeps its snap", () => {
    expect(dealTempo({ ...base, paperWeight: "light" })).toBe(0.8);
    expect(dealTempo({ ...base })).toBe(1.0);
    expect(dealTempo({ ...base, paperWeight: "heavy" })).toBe(1.3);
  });
});
