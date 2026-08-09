// Font size is authored in `cqmax` — 1% of the LARGER canvas dimension.
// That unit is writing-mode-blind, but text is not: horizontal text reads
// along the width, vertical-rl reads along the HEIGHT. So the same number
// means very different things depending on which axis the text runs down.
//
// Measured on real banner sizes (chars that fit along the reading axis):
//
//   728x90   fontSize 5 → 19 chars horizontal,  2 chars vertical
//   728x90   fontSize 1 → 99 chars horizontal, 12 chars vertical
//   300x600  fontSize 5 → 10 chars horizontal, 20 chars vertical
//
// On a leaderboard the whole useful range for vertical text is ~0.5–2 while
// horizontal wants 2–10, and the default of 5 renders two glyphs. On a
// portrait canvas it inverts. Hence: the control has to know the writing
// mode and the canvas, or the numbers are arbitrary.
//
// Pure functions, no DOM — the panel supplies the measured canvas box.

/** The canvas box `cqmax` resolves against, in CSS px. */
export interface CanvasBox {
  w: number;
  h: number;
}

/** Smallest rendered size worth allowing; below this text is decoration. */
const MIN_RENDERED_PX = 4;

/** 1cqmax in CSS px. Guards a zero/degenerate box so callers never divide by 0. */
export function cqmaxPx(box: CanvasBox): number {
  return Math.max(box.w, box.h, 1) / 100;
}

/**
 * The axis the text READS along, in CSS px: width for horizontal-tb,
 * height for vertical-rl. This is the axis that decides how much text
 * fits, and the one `cqmax` ignores.
 */
export function readingAxisPx(box: CanvasBox, vertical: boolean): number {
  return Math.max(vertical ? box.h : box.w, 1);
}

/** Rendered px for an authored cqmax font size. */
export function renderedPx(fontSize: number, box: CanvasBox): number {
  return fontSize * cqmaxPx(box);
}

/**
 * Roughly how many full-width glyphs fit along the reading axis. Full-width
 * (CJK) advance ≈ the font size, which is the case that actually uses
 * vertical-rl, so this is a fair estimate exactly where it matters.
 */
export function charsAlongAxis(fontSize: number, box: CanvasBox, vertical: boolean): number {
  const px = renderedPx(fontSize, box);
  if (px <= 0) return 0;
  return Math.floor(readingAxisPx(box, vertical) / px);
}

/**
 * Bounds and step for the font-size input, in authored cqmax units.
 *
 *   min  — renders at MIN_RENDERED_PX
 *   max  — one glyph spans the whole reading axis; past this nothing fits
 *   step — one press ≈ 1px of rendered size, so the control feels the same
 *          on every canvas instead of being coarse on one and twitchy on
 *          another
 */
export function fontSizeControlRange(
  box: CanvasBox,
  vertical: boolean,
): { min: number; max: number; step: number } {
  const cq = cqmaxPx(box);
  const round = (n: number): number => Math.max(0.01, Math.round(n * 100) / 100);
  return {
    min: round(MIN_RENDERED_PX / cq),
    max: round(readingAxisPx(box, vertical) / cq),
    step: round(1 / cq),
  };
}

/**
 * Rescale an authored font size when the writing mode flips, so the text
 * keeps roughly the same characters-per-line instead of collapsing.
 *
 * Flipping horizontal→vertical on a 728x90 swaps a 728px reading axis for a
 * 90px one: at the same number the line goes from 19 glyphs to 2, which is
 * what makes the control feel broken — you toggle the mode and then have to
 * hunt for a usable number in a range you can't see. Scaling by the ratio of
 * reading axes preserves the fit, and on a square-ish canvas it is a no-op.
 *
 * Returns the size unchanged when the mode isn't actually changing.
 */
export function rescaleForWritingMode(
  fontSize: number,
  box: CanvasBox,
  fromVertical: boolean,
  toVertical: boolean,
): number {
  if (fromVertical === toVertical) return fontSize;
  const before = readingAxisPx(box, fromVertical);
  const after = readingAxisPx(box, toVertical);
  const scaled = (fontSize * after) / before;
  // Two decimals matches the control's own precision; never round to 0,
  // which would make the text vanish on an extreme aspect ratio.
  return Math.max(0.01, Math.round(scaled * 100) / 100);
}
