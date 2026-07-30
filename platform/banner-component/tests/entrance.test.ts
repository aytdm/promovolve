// @vitest-environment jsdom
// Entrance (animationFrom) helpers: the snap-to-start pose and the
// tween-home writes. jsdom has no layout, but style writes are exact.
import { describe, expect, it } from "vitest";
import { applyEntranceStart, playEntranceHome } from "../src/motion";

const base = { left: 10, top: 20, rotation: 0, opacity: 1 };

describe("entrance helpers", () => {
  it("applyEntranceStart offsets position and sets absolute scale/opacity", () => {
    const el = document.createElement("div");
    applyEntranceStart(el, { dx: -5, dy: 3, scale: 0.9, opacity: 0 }, base);
    expect(el.style.transition).toBe("none");
    expect(el.style.left).toBe("5%");
    expect(el.style.top).toBe("23%");
    expect(el.style.scale).toBe("0.9");
    expect(el.style.opacity).toBe("0");
  });

  it("only touches the fields the entrance moves", () => {
    const el = document.createElement("div");
    el.style.left = "42%";
    applyEntranceStart(el, { opacity: 0 }, base);
    expect(el.style.left).toBe("42%"); // untouched — pure fade
    expect(el.style.opacity).toBe("0");
  });

  it("playEntranceHome transitions exactly the moved fields back to base", () => {
    const el = document.createElement("div");
    const from = { dy: 5, opacity: 0, duration: 0.5, easing: "linear" };
    applyEntranceStart(el, from, base);
    playEntranceHome(el, from, base);
    expect(el.style.transition).toContain("top 0.5s linear");
    expect(el.style.transition).toContain("opacity 0.5s linear");
    expect(el.style.transition).not.toContain("left");
    expect(el.style.top).toBe("20%");
    expect(el.style.opacity).toBe("1");
  });
});
