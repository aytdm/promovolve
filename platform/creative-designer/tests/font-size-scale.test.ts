import { describe, expect, it } from "vitest";
import {
  charsAlongAxis,
  cqmaxPx,
  fontSizeControlRange,
  readingAxisPx,
  renderedPx,
  rescaleForWritingMode,
} from "../src/font-size-scale";

// Anchored on a real measurement: rendering あ at N cqmax inside a
// container-type:size box of each banner size in Chromium gave 19 / 2 chars
// on the leaderboard at fontSize 5. charsAlongAxis idealises the advance as
// exactly the font size, so it says 20 / 2 — within a glyph, which is all
// the control needs to show. The point these numbers pin down is the ORDER
// OF MAGNITUDE gap between the two writing modes, not the exact count.
const LEADERBOARD = { w: 728, h: 90 };
const RECTANGLE = { w: 300, h: 250 };
const HALF_PAGE = { w: 300, h: 600 };

describe("font-size-scale", () => {

  it("resolves cqmax against the LARGER dimension, whatever the writing mode", () => {
    expect(cqmaxPx(LEADERBOARD)).toBeCloseTo(7.28, 2);
    expect(cqmaxPx(HALF_PAGE)).toBeCloseTo(6, 2);
    // Same glyph px in both modes — the unit is writing-mode-blind, which is
    // the whole reason the control needed to stop being blind too.
    expect(renderedPx(5, LEADERBOARD)).toBeCloseTo(36.4, 1);
  });

  it("reads along width for horizontal and height for vertical", () => {
    expect(readingAxisPx(LEADERBOARD, false)).toBe(728);
    expect(readingAxisPx(LEADERBOARD, true)).toBe(90);
  });

  it("reproduces the measured chars-per-axis that motivated this", () => {
    // 728x90 at fontSize 5: comfortable across, two glyphs down.
    expect(charsAlongAxis(5, LEADERBOARD, false)).toBe(20);
    expect(charsAlongAxis(5, LEADERBOARD, true)).toBe(2);
    // Portrait inverts it — vertical is the better-behaved mode there.
    expect(charsAlongAxis(5, HALF_PAGE, false)).toBe(10);
    expect(charsAlongAxis(5, HALF_PAGE, true)).toBe(20);
  });

  describe("control range", () => {

    it("one step is about one rendered pixel, on any canvas", () => {
      for (const box of [LEADERBOARD, RECTANGLE, HALF_PAGE]) {
        const { step } = fontSizeControlRange(box, false);
        expect(renderedPx(step, box)).toBeCloseTo(1, 1);
      }
    });

    it("caps at one glyph spanning the reading axis, so max differs by mode", () => {
      const horiz = fontSizeControlRange(LEADERBOARD, false);
      const vert = fontSizeControlRange(LEADERBOARD, true);
      expect(charsAlongAxis(horiz.max, LEADERBOARD, false)).toBe(1);
      expect(charsAlongAxis(vert.max, LEADERBOARD, true)).toBe(1);
      // Vertical on a wide canvas is the compressed case: a far lower ceiling.
      expect(vert.max).toBeLessThan(horiz.max);
    });

    it("floors at a readable size rather than 0", () => {
      const { min } = fontSizeControlRange(LEADERBOARD, true);
      expect(renderedPx(min, LEADERBOARD)).toBeCloseTo(4, 0);
      expect(min).toBeGreaterThan(0);
    });

    it("never returns a zero step on a degenerate box", () => {
      const { min, max, step } = fontSizeControlRange({ w: 0, h: 0 }, false);
      expect(step).toBeGreaterThan(0);
      expect(min).toBeGreaterThan(0);
      expect(max).toBeGreaterThan(0);
    });
  });

  describe("rescale on writing-mode flip", () => {

    it("preserves how much text fits when flipping to vertical", () => {
      const before = charsAlongAxis(5, LEADERBOARD, false);
      const after = rescaleForWritingMode(5, LEADERBOARD, false, true);
      // Same fit, not the same number — 5 would have rendered two glyphs.
      expect(charsAlongAxis(after, LEADERBOARD, true)).toBeCloseTo(before, -1);
      expect(after).toBeLessThan(5);
    });

    it("round-trips back to about where it started", () => {
      const down = rescaleForWritingMode(5, LEADERBOARD, false, true);
      const up = rescaleForWritingMode(down, LEADERBOARD, true, false);
      expect(up).toBeCloseTo(5, 1);
    });

    it("is a no-op when the mode is not actually changing", () => {
      expect(rescaleForWritingMode(5, LEADERBOARD, false, false)).toBe(5);
      expect(rescaleForWritingMode(5, LEADERBOARD, true, true)).toBe(5);
    });

    it("barely moves on a square canvas, where the axes agree", () => {
      const square = { w: 400, h: 400 };
      expect(rescaleForWritingMode(5, square, false, true)).toBeCloseTo(5, 2);
    });

    it("never rounds a tiny size away to nothing on an extreme aspect", () => {
      const strip = { w: 970, h: 30 };
      expect(rescaleForWritingMode(0.5, strip, false, true)).toBeGreaterThan(0);
    });
  });
});
