# Global Privacy Control (GPC)

Global Privacy Control is a browser-level signal that tells a site: *do not sell
or share my personal information.* Promovolve serves ads to browsers sending
`Sec-GPC: 1` exactly as it serves every other browser — because there is no
personal information to sell or share, and never was.

This page explains that position, because "we serve ads under GPC" is the kind
of sentence that deserves its reasoning in full.

## Why serving is the correct response

The auction reads the **page**, not the viewer.

- **No identifier is ingested.** The serve request carries a publisher id, the
  page URL, and slot dimensions. No cookie, no device id, no fingerprint, no
  hashed email.
- **No profile is built.** Candidates are matched on the page's content
  category. Nothing about the reader enters the scoring function.
- **No server-side viewer identity exists.** There is no per-viewer record to
  attach a preference to, to sell, to share, or to leak.
- **Pricing is CPM-only.** Nothing about an individual is being valued.

Given that, declining to serve on `Sec-GPC: 1` would be an odd gesture: it would
concede that normal Promovolve serving is the kind of thing GPC exists to stop.
It is not, and the architecture makes that structurally true rather than
promised. Honoring an opt-out from data collection by suppressing an ad that
collects no data communicates the opposite of what is happening.

Privacy here is "can't," not "won't." The one-time cost of that is that the
usual privacy gestures have nothing to attach to.

## Why this is not a revenue rationalization

It would be if the reasoning ran the other way — if the architecture collected
viewer data and the doc argued its way out of the signal. It doesn't. Test the
claim directly: read `ServeRoutes.scala`, follow `BatchServeReq` into
`AdServer.BatchSelect`, and look for a viewer field. There isn't one. The code
is open source precisely so this is checkable rather than trusted.

The revenue consequence is real and worth stating plainly: GPC is **on by
default** in Brave and DuckDuckGo. Suppressing serve on the header meant every
one of those viewers was a guaranteed zero-fill on every publisher, with no
privacy gained by anybody — a cost paid by publishers for a gesture.

## What the earlier implementation did

Until 2026-08-12, `ServeRoutes` short-circuited `POST /v1/serve/batch` to
`204 No Content` whenever `Sec-GPC: 1` was present. That branch has been
removed.

It also had a bug worth recording. `204` is a 2xx, so the browser tag's
`resp.ok` check passed and the empty body reached `resp.json()`, which threw
`Unexpected end of JSON input`. The throw was then classified as a transient
network fault and **retried**, producing a second 204 and a second throw. Every
Brave-desktop pageview logged two console errors, made two serve requests, and
reported a network failure to the mount heartbeat instead of a clean no-fill.

The tag now treats `204` as an answered response with no winners
(`bootstrap.ts`, `batchAttempt`). That path still matters: the batch endpoint
returns `204` for an operator-suspended site and for content too old to serve.

## If you are deploying Promovolve yourself

This is a per-deployment policy decision, not a law of the codebase. If your
jurisdiction, counsel, or publisher agreements require declining to serve on
GPC, reinstate the branch at the top of the batch route:

```scala
path("batch") {
  post {
    optionalHeaderValueByName("Sec-GPC") {
      case Some("1") => complete(StatusCodes.NoContent)
      case _         =>
        entity(as[BatchServeReq]) { req =>
          // normal serving flow
        }
    }
  }
}
```

The tag handles the resulting `204` correctly, so reinstating it is a one-place
change.

## Browser support

| Browser        | GPC support                          | Default |
|----------------|--------------------------------------|---------|
| **Brave**      | Native                               | On      |
| **DuckDuckGo** | Native (desktop & mobile)            | On      |
| **Firefox**    | Native (Settings → Privacy)          | Off     |
| **Chrome**     | Via extension (Privacy Badger, etc.) | N/A     |
| **Edge**       | Via extension                        | N/A     |
| **Safari**     | Not natively supported               | N/A     |

## Why there is no server-side opt-out registry

An earlier design considered a server-side do-not-target registry keyed on a
hashed user identifier (`uid`), so logged-in users could opt out
browser-independently. We deliberately do **not** build this:

- It would require ingesting a per-user identifier at serve time — reintroducing
  exactly the server-side viewer identity the architecture avoids by design.
- It would create a new store of hashed-email PII, with its own access/deletion
  obligations.
- It solves a problem the architecture already solves structurally: a
  do-not-target registry exists to let a user opt out of being profiled, but
  Promovolve builds no per-viewer profile to begin with. Adding a tracking
  identifier in order to suppress tracking that does not happen is incoherent.

## References

- [GPC Specification](https://globalprivacycontrol.github.io/gpc-spec/)
- [California Attorney General GPC FAQ](https://oag.ca.gov/privacy/ccpa)
- [GPC.org](https://globalprivacycontrol.org/)
