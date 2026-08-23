// Frequency capping, browser side (docs/design/FREQUENCY_CAPPING.md).
//
// The server sends each winner's campaign policy {campaignId, n, windowMs};
// the bootstrap records every BILLED impression of an auction winner with
// that policy; before the next batch this module turns the records into the
// list of campaigns the browser declines. Nothing here knows who the reader
// is — the only thing that ever leaves the browser is that list, bounded.
import type { Impression } from "./dogear-storage.js";

/** Server-side bound is the same (ExcludeCampaigns.MaxEntries). */
export const MAX_EXCLUDE = 32;

/** Campaign ids at or over their cap, most recently seen first, ≤ MAX_EXCLUDE.
 *  The policy used for a campaign is the one stamped on its MOST RECENT
 *  record — a loosened or removed cap takes effect as soon as one more ad
 *  from that campaign is seen; a tightened one on the next page load. A
 *  record with no usable policy (n ≤ 0 or windowMs ≤ 0) never caps. */
export function cappedCampaigns(records: Impression[], now: number = Date.now()): string[] {
  const byCampaign = new Map<string, Impression[]>();
  for (const r of records) {
    const list = byCampaign.get(r.campaignId);
    if (list) list.push(r); else byCampaign.set(r.campaignId, [r]);
  }
  const capped: Array<{ id: string; last: number }> = [];
  for (const [id, list] of byCampaign) {
    list.sort((a, b) => b.at - a.at);
    const policy = list[0];
    if (!policy || !(policy.n > 0) || !(policy.windowMs > 0)) continue;
    const since = now - policy.windowMs;
    let count = 0;
    for (const r of list) if (r.at > since && r.at <= now) count++;
    if (count >= policy.n) capped.push({ id, last: policy.at });
  }
  capped.sort((a, b) => b.last - a.last);
  return capped.slice(0, MAX_EXCLUDE).map((c) => c.id);
}
