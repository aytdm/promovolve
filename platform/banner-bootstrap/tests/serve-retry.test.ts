// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// One transient fetch failure used to cost the whole pageview its ad:
// runBatch gave up after a single attempt. On mobile, one radio handoff
// is enough to drop a request — observed live 2026-08-06 as 11 consecutive
// `network` heartbeats from one phone over 52s, then normal renders the
// moment a request got through. These tests pin the retry that fixes it,
// and — just as important — pin what must NOT be retried.

async function load(retryDelayMs = 1): Promise<typeof import("../src/bootstrap")> {
  vi.resetModules(); // module-global config → fresh per test
  const mod = await import("../src/bootstrap");
  window.promovolve?.setConfig({
    pub: "test-pub",
    apiBase: "https://ads.example.com",
    batchRetryDelayMs: retryDelayMs, // 1ms keeps the tests fast; 0 disables
  });
  return mod;
}

const SLOTS = [{ id: "slot-a", w: 300, h: 250 }];

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ seatbid: [{ id: "slot-a", winner: { assetUrl: "x" } }] }),
  } as unknown as Response;
}

describe("isTransientFailure", () => {
  it("retries transport failures and 5xx", async () => {
    const { isTransientFailure } = await load();
    expect(isTransientFailure("network")).toBe(true);
    expect(isTransientFailure("timeout")).toBe(true);
    expect(isTransientFailure("http_500")).toBe(true);
    expect(isTransientFailure("http_503")).toBe(true);
  });

  it("does NOT retry 4xx — a bad pub id fails identically every time", async () => {
    const { isTransientFailure } = await load();
    expect(isTransientFailure("http_400")).toBe(false);
    expect(isTransientFailure("http_403")).toBe(false);
    expect(isTransientFailure("http_404")).toBe(false);
  });

  it("does not retry when there was no failure", async () => {
    const { isTransientFailure } = await load();
    expect(isTransientFailure(undefined)).toBe(false);
  });
});

describe("runBatch retry", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("recovers the pageview when the first request fails at the network layer", async () => {
    const { runBatch } = await load();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const out = await runBatch(SLOTS, []);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.answered).toBe(true);
    expect(out.results.get("slot-a")).toBeDefined();
  });

  it("makes exactly one extra attempt, then reports the final reason", async () => {
    const { runBatch } = await load();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const out = await runBatch(SLOTS, []);

    expect(fetchMock).toHaveBeenCalledTimes(2); // not 3 — one retry only
    expect(out.answered).toBe(false);
    expect(out.failReason).toBe("network");
  });

  it("does not retry a 4xx", async () => {
    const { runBatch } = await load();
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400 } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const out = await runBatch(SLOTS, []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.failReason).toBe("http_400");
  });

  it("retries a 5xx", async () => {
    const { runBatch } = await load();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const out = await runBatch(SLOTS, []);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.answered).toBe(true);
  });

  it("never fires a second request when the first one succeeds", async () => {
    const { runBatch } = await load();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await runBatch(SLOTS, []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("batchRetryDelayMs: 0 disables the retry", async () => {
    const { runBatch } = await load(0);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await runBatch(SLOTS, []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// A deliberate no-fill arrives as 204 with an empty body — suspended site,
// content too old, or (until 2026-08-12) a Sec-GPC opt-out. 204 is a 2xx, so
// `resp.ok` is true and the empty body used to reach resp.json(), throw
// "Unexpected end of JSON input", and be misfiled as a transient `network`
// fault — which then earned a retry that could only produce the same 204.
// Found live in Brave desktop, where GPC is on by default: two console errors
// and two serve requests per pageview, reported to the heartbeat as breakage.
describe("runBatch 204", () => {
  beforeEach(() => vi.unstubAllGlobals());

  function noContentResponse(): Response {
    return {
      ok: true,
      status: 204,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    } as unknown as Response;
  }

  it("treats 204 as an answered no-fill and never retries it", async () => {
    const { runBatch } = await load();
    const fetchMock = vi.fn().mockResolvedValue(noContentResponse());
    vi.stubGlobal("fetch", fetchMock);

    const out = await runBatch(SLOTS, []);

    expect(fetchMock).toHaveBeenCalledTimes(1); // answered → no second attempt
    expect(out.answered).toBe(true);
    expect(out.failReason).toBeUndefined(); // heartbeat reads this as no_fill
    expect(out.results.size).toBe(0);
    expect(out.needClassify).toBe(false);
  });
});
