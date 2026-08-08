import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Each test gets a fresh fake-indexeddb factory (so the `promovolve-dogear`
// database starts empty) and a fresh module instance (so the storage
// module's internal `dbPromise` cache is not reused across tests).
async function loadStorage(): Promise<typeof import("../src/dogear-storage")> {
  vi.resetModules();
  return await import("../src/dogear-storage");
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

// All tests construct Pins with the same default-TTL semantics the
// bootstrap uses when the server didn't supply a campaign endAt: 7
// days from foldedAt. Local helper so tests don't have to import the
// production pinExpiresAt() (which is exercised separately).
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const defaultExpiry = (foldedAt: number): number => foldedAt + SEVEN_DAYS;

describe("dogear-storage", () => {

  it("setPin → getPin round-trips the same record", async () => {
    const { setPin, getPin } = await loadStorage();
    const foldedAt = Date.now();
    await setPin({
      slotId:     "leader-top",
      creativeId: "ad_7f3a9b",
      page:       2,
      foldedAt,
      lastSeenAt: foldedAt,
      expiresAt:  defaultExpiry(foldedAt),
    });
    const pin = await getPin("leader-top");
    expect(pin).not.toBeNull();
    expect(pin?.slotId).toBe("leader-top");
    expect(pin?.creativeId).toBe("ad_7f3a9b");
    expect(pin?.page).toBe(2);
  });

  it("getPin returns null for an unknown slot", async () => {
    const { getPin } = await loadStorage();
    expect(await getPin("never-folded")).toBeNull();
  });

  it("setPin overwrites an existing record on refold", async () => {
    const { setPin, getPin } = await loadStorage();
    const t0 = Date.now() - 5000;
    const t1 = Date.now() - 1000;
    await setPin({ slotId: "s1", creativeId: "c1", page: 0, foldedAt: t0, lastSeenAt: t0, expiresAt: defaultExpiry(t0) });
    await setPin({ slotId: "s1", creativeId: "c1", page: 2, foldedAt: t1, lastSeenAt: t1, expiresAt: defaultExpiry(t1) });
    const pin = await getPin("s1");
    expect(pin?.page).toBe(2);
    expect(pin?.foldedAt).toBe(t1);
  });

  it("getPin returns null and deletes a record older than 7 days (lazy expiry)", async () => {
    const longAgo = Date.now() - SEVEN_DAYS - 1000;
    const storage = await loadStorage();
    await storage.setPin({ slotId: "s1", creativeId: "c1", page: 0, foldedAt: longAgo, lastSeenAt: longAgo, expiresAt: defaultExpiry(longAgo) });

    expect(await storage.getPin("s1")).toBeNull();
    // Read again — pin should already be gone (deleted lazily on the first read).
    expect(await storage.getPin("s1")).toBeNull();
  });

  it("getPin keeps a record under 7 days old (recently seen)", async () => {
    // Pre-existing test updated for the lastSeenAt idle sweep: a pin
    // folded 6 days ago survives the 7-day expiry ONLY if the reader
    // re-encountered it within the 24h idle window — an old fold with
    // no recent sighting is use-it-or-lose-it swept by design.
    const SIX_DAYS = 6 * 24 * 60 * 60 * 1000;
    const recent = Date.now() - SIX_DAYS;
    const storage = await loadStorage();
    await storage.setPin({
      slotId: "s1", creativeId: "c1", page: 0,
      foldedAt: recent, expiresAt: defaultExpiry(recent),
      lastSeenAt: Date.now() - 1000,
    });
    const pin = await storage.getPin("s1");
    expect(pin).not.toBeNull();
    expect(pin?.foldedAt).toBe(recent);
  });

  it("a legacy record with no lastSeenAt falls back to foldedAt", async () => {
    // Records written before the lastSeenAt field exists in the wild, and
    // isFresh handles them with `pin.lastSeenAt ?? pin.foldedAt`. Every
    // other fixture here now sets the field (the type requires it), so
    // without this test that fallback branch would be unreachable from
    // the suite. The cast is deliberate: it constructs exactly the shape
    // an older bootstrap left in the store.
    const storage = await loadStorage();
    const recent = Date.now() - 1000;
    const legacy = { slotId: "s1", creativeId: "c1", page: 0, foldedAt: recent, expiresAt: defaultExpiry(recent) };
    await storage.setPin(legacy as unknown as import("../src/dogear-storage").Pin);
    expect((await storage.getPin("s1"))?.creativeId).toBe("c1");

    // ...and the same fallback still sweeps one that is genuinely stale.
    const old = Date.now() - SEVEN_DAYS - 1000;
    const legacyOld = { slotId: "s2", creativeId: "c2", page: 0, foldedAt: old, expiresAt: defaultExpiry(old) };
    await storage.setPin(legacyOld as unknown as import("../src/dogear-storage").Pin);
    expect(await storage.getPin("s2")).toBeNull();
  });

  it("clearPin removes the record", async () => {
    const storage = await loadStorage();
    const foldedAt = Date.now();
    await storage.setPin({ slotId: "s1", creativeId: "c1", page: 0, foldedAt, lastSeenAt: foldedAt, expiresAt: defaultExpiry(foldedAt) });
    expect(await storage.getPin("s1")).not.toBeNull();
    await storage.clearPin("s1");
    expect(await storage.getPin("s1")).toBeNull();
  });

  it("clearPin is a no-op for an unknown slot", async () => {
    const { clearPin } = await loadStorage();
    await expect(clearPin("never-folded")).resolves.toBeUndefined();
  });

  it("sweepExpired deletes only records older than 7 days", async () => {
    const now = Date.now();
    const storage = await loadStorage();
    const old1Folded = now - SEVEN_DAYS - 1;
    const old2Folded = now - SEVEN_DAYS - 60_000;
    const freshFolded = now - 1000;
    await storage.setPin({ slotId: "old1",  creativeId: "c1", page: 0, foldedAt: old1Folded,  lastSeenAt: old1Folded,  expiresAt: defaultExpiry(old1Folded) });
    await storage.setPin({ slotId: "old2",  creativeId: "c2", page: 1, foldedAt: old2Folded,  lastSeenAt: old2Folded,  expiresAt: defaultExpiry(old2Folded) });
    await storage.setPin({ slotId: "fresh", creativeId: "c3", page: 2, foldedAt: freshFolded, lastSeenAt: freshFolded, expiresAt: defaultExpiry(freshFolded) });

    await storage.sweepExpired();

    expect(await storage.getPin("old1")).toBeNull();
    expect(await storage.getPin("old2")).toBeNull();
    expect(await storage.getPin("fresh")).not.toBeNull();
  });

  it("sweepExpired is a no-op when the store is empty", async () => {
    const { sweepExpired } = await loadStorage();
    await expect(sweepExpired()).resolves.toBeUndefined();
  });

  it("getPin / setPin / clearPin / sweepExpired no-op when indexedDB is unavailable", async () => {
    // Simulate the IndexedDB-unavailability fallback by stripping the
    // global. Per spec design constraints, the spread still works in
    // this case — folding is silently disabled.
    vi.stubGlobal("indexedDB", undefined);
    const storage = await loadStorage();

    await expect(storage.getPin("s1")).resolves.toBeNull();
    const foldedAt = Date.now();
    await expect(storage.setPin({ slotId: "s1", creativeId: "c1", page: 0, foldedAt, lastSeenAt: foldedAt, expiresAt: defaultExpiry(foldedAt) })).resolves.toBeUndefined();
    await expect(storage.clearPin("s1")).resolves.toBeUndefined();
    await expect(storage.sweepExpired()).resolves.toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("clearPinsByCreativeIds deletes matching pins + counted records, leaves others", async () => {
    // The server's stalePins signal: pins whose creative is gone or
    // whose slot was renamed away. Matching is by creativeId (pins are
    // keyed by slotId), and non-stale pins must survive untouched.
    const storage = await loadStorage();
    const t = Date.now();
    await storage.setPin({ slotId: "s1", creativeId: "stale-1", page: 0, foldedAt: t, lastSeenAt: t, expiresAt: defaultExpiry(t) });
    await storage.setPin({ slotId: "s2", creativeId: "alive-1", page: 0, foldedAt: t, lastSeenAt: t, expiresAt: defaultExpiry(t) });
    await storage.markCounted("stale-1", defaultExpiry(t));
    await storage.markCounted("alive-1", defaultExpiry(t));

    await storage.clearPinsByCreativeIds(["stale-1", "never-pinned"]);

    expect(await storage.getPin("s1")).toBeNull();
    expect(await storage.wasCounted("stale-1")).toBe(false);
    const survivor = await storage.getPin("s2");
    expect(survivor?.creativeId).toBe("alive-1");
    expect(await storage.wasCounted("alive-1")).toBe(true);
  });

  it("clearPinsByCreativeIds with an empty list is a no-op", async () => {
    const storage = await loadStorage();
    const t = Date.now();
    await storage.setPin({ slotId: "s1", creativeId: "c1", page: 0, foldedAt: t, lastSeenAt: t, expiresAt: defaultExpiry(t) });
    await storage.clearPinsByCreativeIds([]);
    expect((await storage.getPin("s1"))?.creativeId).toBe("c1");
  });

  // claimUnfoldReport is the dedup that keeps the server's retention
  // metric — (folds - unfolds)/folds — well-formed. Folds are deduped
  // per creative, so unfolds must be too: exactly one reported unfold
  // per reported fold, never more, never unpaired.
  it("claimUnfoldReport grants once per counted fold, then refuses", async () => {
    const storage = await loadStorage();
    await storage.markCounted("c1", defaultExpiry(Date.now()));
    expect(await storage.claimUnfoldReport("c1")).toBe(true);
    expect(await storage.claimUnfoldReport("c1")).toBe(false);
    expect(await storage.claimUnfoldReport("c1")).toBe(false);
  });

  it("claimUnfoldReport refuses when no fold was ever reported", async () => {
    // The fold was deduped as a refold, or the pin came from an earlier
    // window — either way the server has nothing to subtract.
    const storage = await loadStorage();
    expect(await storage.claimUnfoldReport("never-counted")).toBe(false);
  });

  it("claimUnfoldReport refuses against an expired counted record", async () => {
    const storage = await loadStorage();
    await storage.markCounted("c1", Date.now() - 1000);
    expect(await storage.claimUnfoldReport("c1")).toBe(false);
  });

  it("claiming an unfold leaves the fold dedup armed (no posterior cycling)", async () => {
    // clearCounted is deliberately NOT called on unfold: a refold inside
    // the same window must stay silent so it can't cycle the fold
    // posterior the auction scores on.
    const storage = await loadStorage();
    await storage.markCounted("c1", defaultExpiry(Date.now()));
    await storage.claimUnfoldReport("c1");
    expect(await storage.wasCounted("c1")).toBe(true);
  });

  it("a fresh fold after clearCounted can report its own unfold again", async () => {
    // Revocation path: creative_removed clears the dedup slate, so a
    // resurrected campaign's fold/unfold pair is reportable afresh.
    const storage = await loadStorage();
    await storage.markCounted("c1", defaultExpiry(Date.now()));
    expect(await storage.claimUnfoldReport("c1")).toBe(true);
    await storage.clearCounted("c1");
    await storage.markCounted("c1", defaultExpiry(Date.now()));
    expect(await storage.claimUnfoldReport("c1")).toBe(true);
  });

  // The iOS Safari blank-page bug. WebKit can leave indexedDB.open() — or a
  // request on an open connection — without firing ANY callback. The
  // bootstrap awaits getAllPins() before it sends /v1/serve/batch, so an
  // unbounded wait there means no serve request and an empty white slot.
  // Nothing throws, so none of this shows up as an error.

  /** An indexedDB whose open() never calls back. */
  const hangingOpen = (): IDBFactory =>
    ({ open: () => ({ onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null }) }) as unknown as IDBFactory;

  /** An indexedDB that opens fine but whose requests never call back. */
  const hangingRequest = (): IDBFactory =>
    ({
      open: () => {
        const req: Record<string, unknown> = {
          onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null,
          result: {
            transaction: () => ({
              objectStore: () => ({ getAll: () => ({}), get: () => ({}), put: () => ({}), delete: () => ({}) }),
            }),
          },
        };
        setTimeout(() => (req.onsuccess as (() => void) | null)?.(), 0);
        return req;
      },
    }) as unknown as IDBFactory;

  it("getAllPins falls back to [] when the open never answers", async () => {
    globalThis.indexedDB = hangingOpen();
    const storage = await loadStorage();
    await expect(storage.getAllPins()).resolves.toEqual([]);
  });

  it("getAllPins falls back to [] when the request never answers", async () => {
    globalThis.indexedDB = hangingRequest();
    const storage = await loadStorage();
    await expect(storage.getAllPins()).resolves.toEqual([]);
  });

  it("a hung open does not poison later calls (cached promise is dropped)", async () => {
    // Without clearing the module-level dbPromise, every later call would
    // await the same dead promise for the life of the page — one wedged
    // open would take out dog-ear state until a reload.
    globalThis.indexedDB = hangingOpen();
    const storage = await loadStorage();
    await expect(storage.getAllPins()).resolves.toEqual([]);

    globalThis.indexedDB = new IDBFactory(); // IndexedDB recovers
    const t = Date.now();
    await storage.setPin({
      slotId: "s1", creativeId: "c1", page: 0, foldedAt: t, lastSeenAt: t, expiresAt: defaultExpiry(t),
    });
    expect((await storage.getPin("s1"))?.creativeId).toBe("c1");
  });

  it("every fallback matches the pre-existing failure behaviour", async () => {
    // A hang must degrade exactly like an unavailable IndexedDB, not
    // differently — claimUnfoldReport in particular must stay false so a
    // wedged store can't emit an unpaired unfold.
    globalThis.indexedDB = hangingOpen();
    const s = await loadStorage();
    await expect(s.getPin("s1")).resolves.toBeNull();
    await expect(s.wasCounted("c1")).resolves.toBe(false);
    await expect(s.claimUnfoldReport("c1")).resolves.toBe(false);
    await expect(s.setPin({
      slotId: "s1", creativeId: "c1", page: 0, foldedAt: 1, lastSeenAt: 1, expiresAt: 2,
    })).resolves.toBeUndefined();
    await expect(s.clearPin("s1")).resolves.toBeUndefined();
    await expect(s.sweepExpired()).resolves.toBeUndefined();
  });

  it("setPin then clearPin then setPin (refold flow) works end-to-end", async () => {
    // Spec scenario: reader folds → unfolds → folds again. Each fold is
    // an independent CPF event; the IDB store records the latest.
    const storage = await loadStorage();
    const t0 = Date.now() - 5000;
    const t1 = Date.now() - 1000;
    await storage.setPin({ slotId: "s1", creativeId: "c1", page: 0, foldedAt: t0, lastSeenAt: t0, expiresAt: defaultExpiry(t0) });
    await storage.clearPin("s1");
    expect(await storage.getPin("s1")).toBeNull();
    await storage.setPin({ slotId: "s1", creativeId: "c1", page: 1, foldedAt: t1, lastSeenAt: t1, expiresAt: defaultExpiry(t1) });
    const pin = await storage.getPin("s1");
    expect(pin?.page).toBe(1);
    expect(pin?.foldedAt).toBe(t1);
  });
});
