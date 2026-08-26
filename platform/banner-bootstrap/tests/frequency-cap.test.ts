import { describe, expect, it } from "vitest";
import { capChecks, cappedCampaigns, MAX_EXCLUDE, withPolicies } from "../src/frequency-cap";
import type { Impression } from "../src/dogear-storage";

// The browser-side half of docs/design/FREQUENCY_CAPPING.md: impression
// records + the campaign's policy → the campaigns this browser declines.
const DAY = 86_400_000;
const rec = (campaignId: string, at: number, n = 2, windowMs = DAY): Impression =>
  ({ campaignId, creativeId: "c", at, n, windowMs });

describe("cappedCampaigns", () => {
  const now = 1_700_000_000_000;

  it("caps a campaign once impressions inside its window reach n", () => {
    expect(cappedCampaigns([rec("A", now - 1000)], now)).toEqual([]);
    expect(cappedCampaigns([rec("A", now - 1000), rec("A", now - 2000)], now)).toEqual(["A"]);
  });

  it("only counts impressions inside the window — the boundary is exclusive", () => {
    const edge = [rec("A", now - DAY), rec("A", now - 1000)]; // one exactly a day old
    expect(cappedCampaigns(edge, now)).toEqual([]);
    const inside = [rec("A", now - DAY + 1), rec("A", now - 1000)];
    expect(cappedCampaigns(inside, now)).toEqual(["A"]);
  });

  it("uses the policy stamped on the MOST RECENT record (a loosened cap applies at once)", () => {
    const rows = [rec("A", now - 3000, 2), rec("A", now - 2000, 2), rec("A", now - 1000, 10)];
    expect(cappedCampaigns(rows, now)).toEqual([]);
  });

  it("never caps a campaign whose latest record carries no usable policy", () => {
    expect(cappedCampaigns([rec("A", now - 1000, 0), rec("A", now - 2000, 0)], now)).toEqual([]);
    expect(cappedCampaigns([rec("A", now - 1000, 2, 0), rec("A", now - 2000, 2, 0)], now)).toEqual([]);
  });

  it("orders by most recent impression and never sends more than MAX_EXCLUDE", () => {
    const rows: Impression[] = [];
    for (let i = 0; i < MAX_EXCLUDE + 10; i++) {
      rows.push(rec(`c${i}`, now - i * 1000, 1));
    }
    const out = cappedCampaigns(rows, now);
    expect(out).toHaveLength(MAX_EXCLUDE);
    expect(out[0]).toBe("c0");
    expect(out).not.toContain(`c${MAX_EXCLUDE + 9}`);
  });

  it("ignores records stamped in the future (clock skew) and is empty for no records", () => {
    expect(cappedCampaigns([], now)).toEqual([]);
    expect(cappedCampaigns([rec("A", now + 5000), rec("A", now + 6000)], now)).toEqual([]);
  });
});

// A capped campaign is excluded from the auction, so it can never win, so it
// can never carry a changed policy back on a winner. Without asking the
// server outright, a cap the advertiser REMOVED would keep declining the ad
// until the old records aged out — up to a week. These two functions are the
// question and the answer.
describe("cap refresh", () => {
  const now = 1_700_000_000_000;

  it("asks only about campaigns it is actually declining", () => {
    const rows = [rec("A", now - 1000), rec("A", now - 2000), rec("B", now - 1000)];
    expect(capChecks(rows, now)).toEqual([{ campaignId: "A", creativeId: "c" }]);
  });

  it("asks with the newest creative it saw from that campaign", () => {
    const rows: Impression[] = [
      { campaignId: "A", creativeId: "old", at: now - 5000, n: 2, windowMs: DAY },
      { campaignId: "A", creativeId: "new", at: now - 1000, n: 2, windowMs: DAY },
    ];
    expect(capChecks(rows, now)).toEqual([{ campaignId: "A", creativeId: "new" }]);
  });

  it("has nothing to ask when nothing is capped", () => {
    expect(capChecks([rec("A", now - 1000)], now)).toEqual([]);
  });

  // THE case this exists for: 上限なし in the dashboard reaches a browser
  // that is already at the cap, and takes effect on the next page load.
  it("stops declining a campaign once the server reports the cap removed", () => {
    const rows = [rec("A", now - 1000), rec("A", now - 2000)];
    expect(cappedCampaigns(rows, now)).toEqual(["A"]);

    const refreshed = withPolicies(rows, [{ campaignId: "A", n: 0, windowMs: 0 }]);
    expect(cappedCampaigns(refreshed, now)).toEqual([]);
  });

  it("applies a tightened cap just as readily", () => {
    const rows = [rec("A", now - 1000, 5), rec("A", now - 2000, 5)];
    expect(cappedCampaigns(rows, now)).toEqual([]);

    const refreshed = withPolicies(rows, [{ campaignId: "A", n: 2, windowMs: DAY }]);
    expect(cappedCampaigns(refreshed, now)).toEqual(["A"]);
  });

  it("leaves campaigns the server said nothing about alone", () => {
    const rows = [rec("A", now - 1000), rec("B", now - 1000)];
    const refreshed = withPolicies(rows, [{ campaignId: "A", n: 0, windowMs: 0 }]);
    expect(refreshed.find((r) => r.campaignId === "B")?.n).toBe(2);
    expect(refreshed).toHaveLength(2);
  });

  it("is a no-op with no policies", () => {
    const rows = [rec("A", now - 1000)];
    expect(withPolicies(rows, [])).toBe(rows);
  });
});
