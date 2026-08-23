import { describe, expect, it } from "vitest";
import { cappedCampaigns, MAX_EXCLUDE } from "../src/frequency-cap";
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
