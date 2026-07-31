// Date-picker calendar suite: the shared "date-picker" partial +
// calCore/dateCal runtime (templates/layout.html), driven in a real
// browser. A Go render test can't catch this component's failure mode:
// Alpine only REMOVES a bound boolean attribute for null/undefined/
// false, so a dayDisabled() that leaked '' from a &&-chain rendered
// every day of the month disabled — the calendar LOOKED fine (the class
// binding does a proper falsy check) but picks did nothing.
//
// The pages under test are the REAL renders: the Go preview test
// (internal/handler/datepicker_preview_test.go, PREVIEW_OUT) executes
// the actual templates, so template drift and runtime drift both land
// here. Prereq: Go toolchain + `npx playwright install chromium`.
// Run: npm test
import { execFileSync } from "child_process";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { extname, join } from "path";
import { chromium } from "playwright";

const PLATFORM = new URL("..", import.meta.url).pathname;

// 1. Render the real pages through the Go preview test.
const previewDir = mkdtempSync(join(tmpdir(), "pv-datepicker-"));
execFileSync("go", ["test", "./internal/handler/", "-run", "TestDatePickerRenders", "-count=1"], {
  cwd: PLATFORM,
  env: { ...process.env, PREVIEW_OUT: previewDir },
  stdio: "inherit",
});

// 2. Serve: /preview/* from the render dir, everything else (static
//    assets the layout references) from platform/.
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const path = pathname.startsWith("/preview/")
      ? join(previewDir, pathname.slice("/preview/".length))
      : join(PLATFORM, pathname);
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const failures = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
  if (!cond) failures.push(name);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

// ── Campaigns page: pickers with NO Min/Max (the regression surface) ──
await page.goto(`http://127.0.0.1:${PORT}/preview/campaigns-en.html`, { waitUntil: "load" });
await page.waitForTimeout(800);
await page.evaluate(() => document.getElementById("new-campaign-form")?.classList.remove("hidden"));

const start = page.locator('[x-data^="dateCal"]').nth(0);
await start.locator("button").first().click();
await page.waitForTimeout(300);

// The bug: every day button carried disabled="disabled". Day cells
// (non-blank) must be enabled when no Min/Max bounds exist.
const dayState = await start.evaluate((root) => {
  const days = [...root.querySelectorAll(".grid-cols-7 button")].filter((b) => b.textContent.trim() !== "");
  return { total: days.length, disabled: days.filter((b) => b.disabled).length };
});
check("unbounded picker: no day is disabled", dayState.total >= 28 && dayState.disabled === 0,
  JSON.stringify(dayState));

// Month navigation moves the header.
const label0 = await start.locator(".text-sm.font-medium").textContent();
await start.locator('button[aria-label="Next month"]').click();
await page.waitForTimeout(200);
const label1 = await start.locator(".text-sm.font-medium").textContent();
check("month nav changes the header", label0 !== label1, `${label0} -> ${label1}`);
await start.locator('button[aria-label="Previous month"]').click();
await page.waitForTimeout(200);

// Picking a day reflects into the trigger label AND the hidden input.
await start.locator(".grid-cols-7 button", { hasText: /^15$/ }).first().click();
await page.waitForTimeout(200);
const startLabel = (await start.locator("span").first().textContent()).trim();
const startHidden = await start.locator('input[type="hidden"]').inputValue();
check("pick reflects into the trigger label", /^\d{4}-\d{2}-15$/.test(startLabel), startLabel);
check("pick reflects into the hidden input (with T00:00)", startHidden === `${startLabel}T00:00`, startHidden);

// The time field recombines into the hidden datetime-local value.
await start.locator('input[type="time"]').fill("09:30");
await page.waitForTimeout(200);
check("time recombines into the hidden value",
  (await start.locator('input[type="hidden"]').inputValue()) === `${startLabel}T09:30`);

// Clear empties the value (optional schedules).
await start.locator('button[aria-label="Clear"]').click();
await page.waitForTimeout(200);
check("clear empties the hidden value", (await start.locator('input[type="hidden"]').inputValue()) === "");

// Both pickers are independent: picking endAt leaves startAt cleared.
const end = page.locator('[x-data^="dateCal"]').nth(1);
await end.locator("button").first().click();
await page.waitForTimeout(300);
await end.locator(".grid-cols-7 button", { hasText: /^20$/ }).first().click();
await page.waitForTimeout(200);
check("pickers are independent state",
  (await end.locator('input[type="hidden"]').inputValue()).endsWith("-20T00:00") &&
  (await start.locator('input[type="hidden"]').inputValue()) === "");

// ── Report page: picker WITH Max — bounds must still disable ──
await page.goto(`http://127.0.0.1:${PORT}/preview/report-en.html`, { waitUntil: "load" });
await page.waitForTimeout(800);
// The bounded picker lives in the collapsed conversions panel.
await page.locator("button", { hasText: "Report conversions" }).click();
await page.waitForTimeout(300);
const bounded = page.locator('[x-data^="dateCal"]').first();
await bounded.locator("button").first().click();
await page.waitForTimeout(300);
// Preview data pins Today/Max = 2026-07-28: later days disabled, on/before enabled.
const boundedState = await bounded.evaluate((root) => {
  const btn = (n) => [...root.querySelectorAll(".grid-cols-7 button")].find((b) => b.textContent.trim() === String(n));
  return { d28: btn(28)?.disabled, d29: btn(29)?.disabled };
});
check("bounded picker: Max day enabled, day after disabled",
  boundedState.d28 === false && boundedState.d29 === true, JSON.stringify(boundedState));

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

await browser.close();
server.close();
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\ndate-picker calendar suite: all green");
