// @vitest-environment jsdom
//
// pageSurface decides what an expanded page paints under its layout.
// The invariant these guard: a page whose background is a VIDEO never
// paints a flat colour the clip is about to cover — it opens on the
// video's own poster, and only a posterless draft falls through to
// transparent. The stage and the sheet's leaf tone must always agree;
// a stage that stops painting the colour while the leaf under it keeps
// painting it has changed nothing on screen.

import { describe, expect, it } from "vitest";
import { pageSurface } from "../src/banner";
import type { Page } from "../src/types";

const page = (p: Partial<Page>): Page => p as Page;

describe("pageSurface", () => {
  it("paints the authored colour when there is no video", () => {
    expect(pageSurface(page({ bg: "#123456" }))).toEqual({ stage: "#123456", leaf: "#123456" });
  });

  it("falls back to the default ink when the page has no bg", () => {
    expect(pageSurface(page({}))).toEqual({ stage: "#0a0a0b", leaf: "#0a0a0b" });
  });

  it("opens a video page on the clip's poster, not the authored colour", () => {
    expect(pageSurface(page({ bg: "#123456", videoBg: { src: "https://cdn/v.mp4", poster: "https://cdn/v.jpg" } })))
      .toEqual({ stage: 'url("https://cdn/v.jpg") center / cover no-repeat', leaf: "transparent" });
  });

  it("frames the poster the way the clip will be framed", () => {
    expect(pageSurface(page({ videoBg: { src: "https://cdn/v.mp4", poster: "https://cdn/v.jpg", fit: "contain" } })).stage)
      .toBe('url("https://cdn/v.jpg") center / contain no-repeat');
  });

  it("goes transparent — never the authored colour — when a video has no poster", () => {
    expect(pageSurface(page({ bg: "#123456", videoBg: { src: "https://cdn/v.mp4" } })))
      .toEqual({ stage: "transparent", leaf: "transparent" });
  });

  it("ignores a videoBg with no src", () => {
    expect(pageSurface(page({ bg: "#123456", videoBg: { src: "" } })))
      .toEqual({ stage: "#123456", leaf: "#123456" });
  });

  it("keeps the colour under a TRANSLUCENT clip — there it is part of the mix", () => {
    expect(pageSurface(page({ bg: "#123456", videoBg: { src: "https://cdn/v.mp4", poster: "https://cdn/v.jpg", opacity: 0.5 } })))
      .toEqual({ stage: "#123456", leaf: "#123456" });
    // opacity: 1 is the same as unset — the clip is the whole surface.
    expect(pageSurface(page({ bg: "#123456", videoBg: { src: "https://cdn/v.mp4", opacity: 1 } })).stage)
      .toBe("transparent");
  });

  it("quotes the poster url so a path with parens/quotes can't break the token", () => {
    expect(pageSurface(page({ videoBg: { src: "https://cdn/v.mp4", poster: 'https://cdn/a(b),"c".jpg' } })).stage)
      .toBe('url("https://cdn/a(b),\\"c\\".jpg") center / cover no-repeat');
  });
});
