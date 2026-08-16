// Collapsed-banner animation viewability contract.
//
// The bug this exists for: item animations (animationFrom entrances,
// animationTo end-pose tweens) used to arm their timers at RENDER time,
// so a banner served below the fold played its whole choreography
// off-screen — by the time the reader scrolled to it, every item sat
// motionless in its end pose. The teaser peel already waited for the
// ≥50% viewability moment (the same gate the impression fires on);
// item motion now waits for the same latch, AND for the atomic
// image-reveal, so nothing plays behind the opacity-0 curtain either.
//
// Four properties, guarded in both directions:
//
//   R  RENDERED    the fixture actually renders both items (a broken
//                  fixture must fail loudly, not pass vacuously)
//   H  HELD        below the fold, the entrance item holds its OFF-pose
//                  and the end-pose item holds its base — long after any
//                  (wrong) render-time timers would have fired
//   P  PLAYS       scrolled into view, both animations run and land
//   M  REDUCED     prefers-reduced-motion poses the END state instantly
//                  at render, even off-screen — there is no motion to
//                  time, and a pose-snap at the 50% crossing would be
//                  exactly the jump the preference asks to avoid
//
// Drives the real component from SOURCE (the fixture page imports the
// banner via the designer's @banner alias) in real Chromium — the gate
// is an IntersectionObserver, which jsdom cannot exercise; that's why
// this lives with the ratchet suites and not banner-component's vitest.
//
// Run: npm run test:anim-viewability   (starts vite itself)
import { spawn } from "child_process";
import { chromium } from "playwright";

const PORT = 5241;
const PAGE_URL = `http://localhost:${PORT}/tests/ratchet/anim-viewability.html`;

// Fixture geometry (anim-viewability.html): entrance item authored at
// left 10% with dx -20 (off-pose -10%); end-pose item authored at left
// 10% with animationTo dx 20 (end pose 30%).
const ENTRANCE_OFF = "-10%";
const REST = "10%";
const END_POSE = "30%";

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: new URL("../..", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "pipe"],
});
// Readiness by polling the HTTP port, not by grepping stdout for
// "Local:" — the banner in non-TTY environments (CI runners) isn't a
// stable contract, and a missed line looks like "vite did not start"
// with zero diagnostics. Output is still captured so a real startup
// failure prints WHY.
let viteOutput = "";
vite.stdout.on("data", (d) => { viteOutput += String(d); });
vite.stderr.on("data", (d) => { viteOutput += String(d); });
const ready = (async () => {
  const deadline = Date.now() + 60000;
  for (;;) {
    if (vite.exitCode !== null) {
      throw new Error(`vite exited with code ${vite.exitCode}:\n${viteOutput}`);
    }
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok || r.status < 500) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      throw new Error(`vite did not start within 60s:\n${viteOutput}`);
    }
    await new Promise((res) => setTimeout(res, 250));
  }
})();

const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

try {
  await ready;
  const browser = await chromium.launch();

  // ── normal motion: held below the fold, played in view ──
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  // The banner sits 250vh down. 1.5s is 3-10× every delay+duration in
  // the fixture, so render-time timers (the bug) would long since have
  // fired and moved the items.
  await page.waitForTimeout(1500);
  let s = await page.evaluate(() => window.__itemStyles());
  check("R  fixture renders both items", s.length === 2, `got ${s.length}`);
  check("H  entrance item HELD at off-pose below the fold",
    s[0]?.left === ENTRANCE_OFF, `left=${s[0]?.left}`);
  check("H  end-pose item HELD at base below the fold",
    s[1]?.left === REST, `left=${s[1]?.left}`);
  // The hold must come from the viewability gate, not from the banner
  // failing to reveal (no images in the fixture → reveal is immediate).
  const op = await page.evaluate(() => window.__bannerOpacity());
  check("H  …while the banner itself is revealed", op === "1", `opacity=${op}`);

  await page.evaluate(() =>
    document.getElementById("slot").scrollIntoView({ block: "center" }));
  await page.waitForTimeout(1500); // delays (0 / 0.1s) + durations (0.3s) + slack
  s = await page.evaluate(() => window.__itemStyles());
  check("P  entrance item tweened home in view",
    s[0]?.left === REST, `left=${s[0]?.left}`);
  check("P  end-pose item reached its target in view",
    s[1]?.left === END_POSE, `left=${s[1]?.left}`);
  await page.close();

  // ── reduced motion: end pose at RENDER, even below the fold ──
  const rm = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await rm.emulateMedia({ reducedMotion: "reduce" });
  await rm.goto(PAGE_URL, { waitUntil: "networkidle" });
  await rm.waitForTimeout(800);
  s = await rm.evaluate(() => window.__itemStyles());
  check("M  reduced motion: entrance item at rest (never off-posed)",
    s[0]?.left === "" || s[0]?.left === REST, `left=${s[0]?.left}`);
  check("M  reduced motion: end pose applied at render",
    s[1]?.left === END_POSE, `left=${s[1]?.left}`);
  await rm.close();

  await browser.close();
} finally {
  vite.kill();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nanimation viewability contract: all assertions hold");
