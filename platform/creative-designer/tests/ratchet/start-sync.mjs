// Start-corner sync contract: a field-bound reader text item begins at the
// SAME point on all three pages, and moving it on ANY page moves it on the
// others — the same "whichever you edit wins" rule size and face follow.
//
// Only the corner is shared. Each page keeps its own box extent, because the
// pages carry different copy and fitReaderFieldBoxes packs each box to its
// own text; asserting that the widths still DIFFER is what stops a lazy
// "copy the whole box" implementation from passing.
//
// Run in BOTH writing modes, because the corner is not always top-left:
// vertical-rl stacks columns right-to-left from the top-RIGHT, so the shared
// coordinate there is the box's RIGHT edge and each page derives its own left
// from its own width. A horizontal-only test cannot see that inverted.
//
// Driven through the real UI — the props fields AND a real mouse drag —
// because the sync is a state subscriber: the pure function can be perfectly
// correct while nothing ever calls it.
//
// Run: npm run test:start-sync   (starts vite itself)
import { spawn } from "child_process";
import { chromium } from "playwright";

const PORT = 5239;

// Boxes deliberately start MISALIGNED and at different widths, so nothing
// below can pass by having agreed already.
const GEO = [
  { hl: [8, 6, 40, 18], body: [45, 6, 50, 20] },
  { hl: [14, 22, 30, 18], body: [55, 14, 38, 20] },
  { hl: [20, 40, 46, 18], body: [65, 26, 44, 20] },
];

const fixtureFor = (vertical) => {
  const txt = (field, top, left, width, height) => ({
    type: "text", field, left, top, width, height, fontSize: 5,
    color: "#ffffff", fontFamily: "sans-serif", textAlign: "left", textFit: "shrink",
    ...(vertical ? { writingMode: "vertical-rl" } : {}),
  });
  return {
    campaignId: "start-sync", landingUrl: "https://example.com",
    creativeName: "start-sync", bannerSize: "expanded", bannerScriptUrl: "",
    creativeId: "", lpTextSnapshot: "", brandKitJson: "", templateId: "",
    pages: [0, 1, 2].map((n) => ({
      headline: `Headline ${n + 1}`, body: `Body copy for page ${n + 1}.`, tag: "T",
      banners: { "mobile-expanded": [
        txt("headline", GEO[n].hl[0], GEO[n].hl[1], GEO[n].hl[2], GEO[n].hl[3]),
        txt("body", GEO[n].body[0], GEO[n].body[1], GEO[n].body[2], GEO[n].body[3]),
      ] },
    })),
  };
};

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: new URL("../..", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "pipe"],
});
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("vite did not start")), 30000);
  vite.stdout.on("data", (d) => {
    if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); }
  });
});

const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

async function runMode(browser, vertical) {
  const label = vertical ? "vertical-rl" : "horizontal";
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  await page.addInitScript((f) => {
    Object.defineProperty(window, "__DESIGNER__", {
      get: () => f, set: () => {}, configurable: false,
    });
  }, fixtureFor(vertical));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const hit = (i) => page.evaluate((n) => {
    const el = document.querySelector(`[data-cd-idx="${n}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, i);
  const clickItem = async (i) => {
    const b = await hit(i);
    if (!b) throw new Error(`no hitbox for item ${i}`);
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(500);
  };
  const val = (l) => page.evaluate((lab) => {
    const row = [...document.querySelectorAll(".cd-props label")]
      .find((x) => x.querySelector("span")?.textContent === lab);
    const f = row?.querySelector("input,select");
    return f ? f.value : null;
  }, l);
  const setNum = (l, v) => page.evaluate(({ lab, x }) => {
    const row = [...document.querySelectorAll(".cd-props label")]
      .find((r) => r.querySelector("span")?.textContent === lab);
    const i = row?.querySelector("input");
    if (!i) return;
    i.focus(); i.value = String(x);
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new Event("change", { bubbles: true }));
    i.blur();
  }, { lab: l, x: v });
  const nav = async (d) => {
    await page.evaluate((x) => [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === x)?.click(), d);
    await page.waitForTimeout(800);
  };
  const goTo = async (n) => {
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) {
        [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "‹")?.click();
      }
    });
    await page.waitForTimeout(600);
    for (let i = 1; i < n; i++) await nav("›");
  };
  // The shared coordinate: the LEFT edge normally, the RIGHT edge where the
  // text starts there. Reading the wrong one is how a vertical regression
  // would slip through green.
  const startOf = async (idx, p) => {
    await goTo(p);
    await clickItem(idx);
    const left = Number(await val("left (%)"));
    const top = Number(await val("top (%)"));
    const width = Number(await val("width (%)"));
    return { top, left, width, edge: vertical ? Math.round((left + width) * 10) / 10 : left };
  };

  const HEADLINE = 0, BODY = 1;

  // ── moved via the props fields, on a NON-master page ──────────────────
  await goTo(2);
  await clickItem(HEADLINE);
  await setNum("left (%)", 25);
  await page.waitForTimeout(400);
  await setNum("top (%)", 12);
  await page.waitForTimeout(1200);
  const src = await startOf(HEADLINE, 2);
  const h1 = await startOf(HEADLINE, 1);
  const h3 = await startOf(HEADLINE, 3);
  check(`${label}  headline start set on p2 reaches p1 and p3`,
    h1.edge === src.edge && h1.top === src.top && h3.edge === src.edge && h3.top === src.top,
    `p2 edge=${src.edge} top=${src.top} | p1 edge=${h1.edge} top=${h1.top} | p3 edge=${h3.edge} top=${h3.top}`);
  // Guards the "only the corner" half — a whole-box copy would equalise these.
  check(`${label}  …and each page keeps its own width`,
    h1.width !== h3.width, `p1 w=${h1.width} p3 w=${h3.width}`);

  // ── moved by a real mouse DRAG, on a different non-master page ────────
  await goTo(3);
  await clickItem(BODY);
  const b = await hit(BODY);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.mouse.move(b.x + 60, b.y - 40, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const bsrc = await startOf(BODY, 3);
  const b1 = await startOf(BODY, 1);
  const b2 = await startOf(BODY, 2);
  // Self-validating: if the drag didn't take, "they all agree" is free.
  check(`${label}  the drag actually moved the body`,
    bsrc.top !== GEO[2].body[0] || bsrc.left !== GEO[2].body[1],
    `was left=${GEO[2].body[1]} top=${GEO[2].body[0]}, now left=${bsrc.left} top=${bsrc.top}`);
  check(`${label}  body DRAGGED on p3 reaches p1 and p2`,
    b1.edge === bsrc.edge && b1.top === bsrc.top && b2.edge === bsrc.edge && b2.top === bsrc.top,
    `p3 edge=${bsrc.edge} top=${bsrc.top} | p1 edge=${b1.edge} top=${b1.top} | p2 edge=${b2.edge} top=${b2.top}`);

  // Per-FIELD, not per-page: moving the body must not drag the headline.
  const hAfter = await startOf(HEADLINE, 1);
  check(`${label}  moving the body left the headline alone`,
    hAfter.top === src.top && hAfter.edge === src.edge,
    `headline edge=${hAfter.edge} top=${hAfter.top}, expected edge=${src.edge} top=${src.top}`);

  await page.close();
}

try {
  await ready;
  const browser = await chromium.launch();
  for (const vertical of [false, true]) await runMode(browser, vertical);
  await browser.close();
} finally {
  vite.kill();
}

console.log(failures.length === 0
  ? "\nstart-corner sync contract: all assertions hold"
  : `\nstart-corner sync contract VIOLATED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
