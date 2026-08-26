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
/** One "is this still capped?" question: a campaign, and a creative of its
 *  own that this browser actually saw. The creative is how the server
 *  reaches the campaign's owner (entities are keyed by advertiser), and is
 *  also why it will answer at all. */
export interface CapCheck {
  campaignId: string;
  creativeId: string;
}

/** The questions to send alongside `excludeCampaigns`.
 *
 *  A browser at a campaign's cap can never learn that the cap was LOWERED to
 *  zero or removed: the policy it reads is the one stamped on the newest
 *  impression record, and being capped is precisely what stops that campaign
 *  winning again, so no newer record can arrive. Without asking, a removed
 *  cap would not take effect until the old records aged out of their window
 *  — up to a week. Same ids as the exclusion list, same bound. */
export function capChecks(records: Impression[], now: number = Date.now()): CapCheck[] {
  const capped = new Set(cappedCampaigns(records, now));
  const out: CapCheck[] = [];
  for (const id of capped) {
    // Newest record for the campaign — any creative of its own will do,
    // but the newest is the one most likely to still exist server-side.
    let newest: Impression | undefined;
    for (const r of records) {
      if (r.campaignId === id && (!newest || r.at > newest.at)) newest = r;
    }
    if (newest?.creativeId) out.push({ campaignId: id, creativeId: newest.creativeId });
  }
  return out;
}

/** Re-stamp stored records with the policy the server just reported.
 *
 *  The policy belongs to the CAMPAIGN, not to any one impression, so every
 *  record for that campaign is updated — which is what lets `cappedCampaigns`
 *  reach the right answer on the very next call. `n <= 0` means the cap is
 *  gone, and those records then never cap again. */
export function withPolicies(
  records: Impression[],
  policies: Array<{ campaignId: string; n: number; windowMs: number }>,
): Impression[] {
  if (policies.length === 0) return records;
  const byCampaign = new Map(policies.map((p) => [p.campaignId, p]));
  return records.map((r) => {
    const p = byCampaign.get(r.campaignId);
    return p && (p.n !== r.n || p.windowMs !== r.windowMs)
      ? { ...r, n: p.n, windowMs: p.windowMs }
      : r;
  });
}

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
