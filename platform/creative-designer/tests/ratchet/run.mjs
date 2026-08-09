// Reader font-size contract: three properties that must hold together.
//
// The bug this exists for: syncAutoFitFontSizes reads the DOM's auto-fitted
// size and writes it to the field on EVERY reader page. autoFitText only
// shrinks, so the viewed page's fit becomes everyone's authored size and
// never recovers — a one-way ratchet. Reported as "edit page 1's body and
// pages 2 and 3 go tiny".
//
// Why all three assertions: three separate fixes for A were shipped and
// reverted because each broke B or C. Testing A alone is how that happened.
//
//   A  RATCHET   editing page 1 must not change page 2's authored size
//   B  NO JUMP   selecting a text item must not change its rendered size
//   C  SYNC      a DELIBERATE size change must still reach every reader page
//   D  EDITOR    opening the text editor must not change the rendered size
//   E  PACKING   the box must hug the text that is actually DRAWN
//
// Drives the real UI: selection through the light-DOM [data-cd-idx] hitboxes
// (not the shadow nodes), page nav through the ‹ › buttons, values read from
// the props panel. No internals, so it stays honest if the plumbing moves.
//
// The designer boots into the PORTRAIT READER, which renders
// page.banners["mobile-expanded"] — NOT page.layout. A fixture aimed at
// page.layout is silently ignored and every assertion passes vacuously.
//
// Run: npm run test:ratchet   (starts vite itself)
import { spawn } from "child_process";
import { chromium } from "playwright";

const PORT = 5233;
const APP_URL = `http://localhost:${PORT}/`;

const txt = (field, top, fontSize, height) => ({
  type: "text", field, left: 6, top, width: 88, height, fontSize,
  color: "#ffffff", fontFamily: "sans-serif", textAlign: "center", textFit: "shrink",
});
const LONG =
  "This is a deliberately much longer body paragraph that cannot fit inside " +
  "the same box at the authored size, so autoFitText must shrink it a long way.";

// EVERY page carries long copy in a box too SMALL for it, so the render is
// CLAMPED from load — the real-world shape, and the only state in which the
// enlarge-on-select bug exists. A roomy fixture makes rendered == authored,
// and then "unchanged on selection" is true no matter what the code does:
// that vacuous green is exactly how a broken fix shipped once already.
const fixture = {
  campaignId: "ratchet-test", landingUrl: "https://example.com",
  creativeName: "ratchet", bannerSize: "expanded", bannerScriptUrl: "",
  creativeId: "", lpTextSnapshot: "", brandKitJson: "", templateId: "",
  pages: [1, 2, 3].map((n) => ({
    headline: `Page ${n}`, body: LONG, tag: "T",
    banners: { "mobile-expanded": [txt("headline", 8, 6, 20), txt("body", 35, 4, 12)] },
  })),
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

try {
  await ready;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  await page.addInitScript((f) => {
    // index.html assigns window.__DESIGNER__ in an inline script that runs
    // AFTER addInitScript, so a plain assignment loses the race.
    Object.defineProperty(window, "__DESIGNER__", {
      get: () => f, set: () => {}, configurable: false,
    });
  }, fixture);
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const clickItem = async (idx) => {
    const b = await page.evaluate((i) => {
      const el = document.querySelector(`[data-cd-idx="${i}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, idx);
    if (!b) throw new Error(`no hitbox for item ${idx}`);
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(600);
  };
  const panelValue = (label) => page.evaluate((l) => {
    const row = [...document.querySelectorAll("label")]
      .find((x) => x.querySelector("span")?.textContent === l);
    return row?.querySelector("input")?.value ?? null;
  }, label);
  const setPanel = (label, value) => page.evaluate(({ l, v }) => {
    const row = [...document.querySelectorAll("label")]
      .find((x) => x.querySelector("span")?.textContent === l);
    const i = row?.querySelector("input");
    if (!i) return false;
    i.focus(); i.value = String(v);
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new Event("change", { bubbles: true }));
    i.blur();
    return true;
  }, { l: label, v: value });
  const renderedSize = () => page.evaluate(() => {
    const sr = document.querySelector("#canvas-host expandable-magazine-banner")?.shadowRoot;
    return sr?.querySelector('[data-layout-idx="1"]')?.style.fontSize ?? null;
  });
  // How much of its box the DRAWN text fills, 0..1. Measured with a Range
  // over the element's contents, the same way packTextItemHeight measures —
  // scrollHeight is floored at clientHeight so it cannot see a gap.
  const packRatio = () => page.evaluate(() => {
    const sr = document.querySelector("#canvas-host expandable-magazine-banner")?.shadowRoot;
    const el = sr?.querySelector('[data-layout-idx="1"]');
    if (!el) return null;
    const box = el.getBoundingClientRect().height;
    if (!(box > 0)) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()];
    if (rects.length === 0) return null;
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return (bottom - top) / box;
  });

  const nav = async (d) => {
    await page.evaluate((x) => [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === x)?.click(), d);
    await page.waitForTimeout(1000);
  };

  const BODY = 1; // headline is 0

  // Guard: if the fixture were ignored the body would read 2.8 (the
  // expandedMobile preset), and every assertion below would pass for the
  // wrong reason.
  await clickItem(BODY);
  const seeded = await panelValue("font size");
  check("fixture is in effect (body authored 4)", seeded === "4", `got ${seeded}`);

  // The whole suite is only meaningful while the render is CLAMPED below the
  // authored size. Assert it up front rather than discovering later that
  // every green was free.
  const seededRender = parseFloat(String(await renderedSize()));
  check("fixture renders CLAMPED (rendered < authored)",
    Number.isFinite(seededRender) && seededRender < Number(seeded) - 0.05,
    `rendered ${seededRender} vs authored ${seeded}`);

  // ── E: the box must hug what is DRAWN, not what was authored ────────────
  // packTextItemHeight measures against item.fontSize ("at full size, not
  // shrunken"), which was right while one number meant both things. Split
  // the authored size from the drawn one and the box gets sized for text
  // that is no longer there — correct font size, oversized box, words not
  // packed. Reported live; A-D all passed while this was broken.
  const pack = await packRatio();
  check("E  box hugs the drawn text", pack !== null && pack > 0.6,
    `text fills ${pack === null ? "?" : Math.round(pack * 100) + "%"} of its box`);

  // ── B: selecting must not change the rendered size ──────────────────────
  const beforeClick = await renderedSize();
  await page.evaluate(() => {
    const el = document.querySelector('[data-cd-idx="0"]');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await clickItem(0);          // select the headline
  await clickItem(BODY);       // come back to the body
  const afterClick = await renderedSize();
  // Self-validating for the same reason as D: if the render is not clamped,
  // "unchanged" proves nothing.
  const bAuthored = Number(await panelValue("font size"));
  const bRendered = parseFloat(String(beforeClick));
  if (!(bRendered < bAuthored - 0.05)) {
    console.log(`  SKIP  B  not exercised — render ${beforeClick} is not clamped below authored ${bAuthored}`);
  } else {
    check("B  no jump on selection", beforeClick === afterClick,
      `${beforeClick} -> ${afterClick}`);
  }

  // ── C: a deliberate size change reaches every reader page ───────────────
  await setPanel("font size", 3);
  await page.waitForTimeout(1500);
  await nav("›");
  await clickItem(BODY);
  const p2Deliberate = await panelValue("font size");
  check("C  deliberate change syncs across pages", p2Deliberate === "3",
    `page 2 got ${p2Deliberate}`);
  await nav("‹");

  // ── A: the ratchet — squeeze page 1's box, page 2 must not follow ───────
  await clickItem(BODY);
  const p1Before = await panelValue("font size");
  await nav("›");
  await clickItem(BODY);
  const p2Before = await panelValue("font size");
  await nav("‹");
  await clickItem(BODY);
  await setPanel("height (%)", 6);   // forces one large fresh shrink on page 1
  await page.waitForTimeout(2500);
  await nav("›");
  await clickItem(BODY);
  const p2After = await panelValue("font size");
  check("A  page 2 unaffected by a page 1 edit", p2Before === p2After,
    `page1 was ${p1Before}; page 2 ${p2Before} -> ${p2After}`);

  // ── D: opening the editor must not resize the text ─────────────────────
  // Runs AFTER A so the box is squeezed and the render is genuinely CLAMPED
  // below the authored size. Before the squeeze the two are equal and this
  // assertion cannot fail — it would pass while proving nothing.
  await nav("‹");
  // The editor stamps a font size onto the element while editing. It used
  // to use the AUTHORED value, which was safe only while the store chased
  // the DOM; now that the store keeps what the author chose, a clamped
  // render and the authored value can differ — and stamping the latter is
  // the "text enlarges when clicked" regression this file exists to stop.
  await clickItem(BODY);
  const beforeEdit = await renderedSize();
  const hb = await page.evaluate(() => {
    const el = document.querySelector(`[data-cd-idx="1"]`);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.dblclick(hb.x, hb.y);
  await page.waitForTimeout(900);
  const duringEdit = await renderedSize();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  // Self-validating: this assertion is only meaningful while the render is
  // CLAMPED below the authored size. If they are equal it cannot fail, and a
  // green that cannot fail is worse than no test — so say that instead.
  const authoredNow = Number(await panelValue("font size"));
  const renderedNow = parseFloat(String(beforeEdit));
  if (!(renderedNow < authoredNow - 0.05)) {
    console.log(`  SKIP  D  not exercised — render ${beforeEdit} is not clamped below authored ${authoredNow}`);
  } else {
    check("D  no resize when the editor opens", beforeEdit === duringEdit,
      `${beforeEdit} -> ${duringEdit}`);
  }


  await browser.close();
} finally {
  vite.kill();
}

console.log(failures.length === 0
  ? "\nreader font-size contract: all assertions hold"
  : `\nreader font-size contract VIOLATED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);