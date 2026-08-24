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

// End-pose (animationTo) offset resolution: dx/dy ride the CURRENT
// authored position (drag-safe), absolute left/top win when present.
import { applySettledState, applyTargetState, resolveTargetValues, targetStartSeconds, transitionFor } from "../src/motion";

describe("end-pose offsets", () => {
  it("resolveTargetValues: dx/dy add to base, absolutes win over offsets", () => {
    expect(resolveTargetValues({ dy: -3, opacity: 0 }, { left: 10, top: 20, rotation: 5 }))
      .toEqual({ left: 10, top: 17, rotation: 5, scale: 1, opacity: 0 });
    expect(resolveTargetValues({ left: 40, dx: 99 }, { left: 10, top: 20, rotation: 0 }).left).toBe(40);
  });

  it("transitionFor and applyTargetState treat dx/dy as position moves", () => {
    const to = { dy: -3, opacity: 0, duration: 0.7 };
    expect(transitionFor(to, 0.8)).toContain("top 0.7s");
    expect(transitionFor(to, 0.8)).not.toContain("left");
    const el = document.createElement("div");
    applyTargetState(el, to, resolveTargetValues(to, { left: 10, top: 20, rotation: 0 }));
    expect(el.style.top).toBe("17%");
    expect(el.style.left).toBe("");
    expect(el.style.opacity).toBe("0");
  });
});

describe("exit timing", () => {
  it("afterEntrance targets start when the entrance lands; plain targets from activation", () => {
    const entrance = { opacity: 0, duration: 0.6, delay: 0.2 };
    expect(targetStartSeconds({ opacity: 0, delay: 2, afterEntrance: true }, entrance)).toBeCloseTo(2.8);
    expect(targetStartSeconds({ opacity: 0, delay: 2, afterEntrance: true }, null)).toBe(2);
    expect(targetStartSeconds({ opacity: 0, delay: 2 }, entrance)).toBe(2);
  });
});

describe("fade easing split", () => {
  it("opacity rides its own gentle curve; position keeps the settling curve; explicit easing wins everywhere", () => {
    const el = document.createElement("div");
    playEntranceHome(el, { dy: 5, opacity: 0, duration: 5 }, { left: 0, top: 0, rotation: 0, opacity: 1 });
    expect(el.style.transition).toContain("top 5s cubic-bezier(0.16,1,0.3,1)");
    expect(el.style.transition).toContain("opacity 5s cubic-bezier(0.37,0,0.63,1)");
    const t = transitionFor({ dy: -3, opacity: 0, duration: 0.7 }, 0.8);
    expect(t).toContain("top 0.7s cubic-bezier(0.16,1,0.3,1)");
    expect(t).toContain("opacity 0.7s cubic-bezier(0.37,0,0.63,1)");
    const explicit = transitionFor({ opacity: 0, duration: 1, easing: "linear" }, 0.8);
    expect(explicit).toContain("opacity 1s linear");
  });
});

// A page in the expanded reader plays its choreography ONCE, at the
// moment it opens. Every later re-staging of that page — turned back
// to, waiting in the pile, landing from a turn — settles it at the end
// pose instead of replaying, and applySettledState is that pose.
describe("settled (already-played) pose", () => {
  it("lands on the end pose with transitions off — no tween on re-entry", () => {
    const el = document.createElement("div");
    // Play state: mid-entrance, off-pose and transitioning.
    applyEntranceStart(el, { dy: 8, opacity: 0 }, base);
    expect(el.style.top).toBe("28%");
    applySettledState(el, { dy: -3, opacity: 0.5, duration: 0.7 }, base);
    expect(el.style.transition).toBe("none");
    expect(el.style.left).toBe("10%");          // entrance home
    expect(el.style.top).toBe("17%");           // …then the end-pose offset
    expect(el.style.opacity).toBe("0.5");
  });

  it("an entrance-only item settles at its authored resting pose", () => {
    const el = document.createElement("div");
    applyEntranceStart(el, { dx: -20, opacity: 0 }, base);
    applySettledState(el, null, base);
    expect(el.style.left).toBe("10%");
    expect(el.style.top).toBe("20%");
    expect(el.style.scale).toBe("");
    expect(el.style.opacity).toBe("");          // base opacity 1 → unset
  });

  it("clears a stale off-pose in every field the base owns", () => {
    const el = document.createElement("div");
    applyEntranceStart(el, { dx: 5, dy: 5, rotate: 30, scale: 0.5, opacity: 0 }, base);
    applySettledState(el, null, { left: 10, top: 20, rotation: 4, opacity: 0.8 });
    expect(el.style.left).toBe("10%");
    expect(el.style.top).toBe("20%");
    expect(el.style.rotate).toBe("4deg");
    expect(el.style.scale).toBe("");
    expect(el.style.opacity).toBe("0.8");
  });
});
