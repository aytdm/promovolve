# Site token check

> Status: **built and live-verified, both halves** (2026-08-22). api: `POST
> /v1/sites/{siteId}/token-check` (`dbf744b`). Plugin 0.5.1:
> `promovolve_token_status`, the `.well-known` suspension (a real 404), the
> settings messages, the 7-day/24-hour notices, `tests/token-test.php`.
> Verified in the Docker WordPress against the production api: stale → 404,
> unknown → 404, unreachable → file served.

## Decision

Add one public, unauthenticated, rate-limited endpoint that lets a CMS
integration ask: *"is the token I am holding still the current token for this
site?"* — and let the WordPress plugin use the answer to **stop serving** the
verification file when the answer is no. Nothing is ever deleted by it.

## Why

The plugin answers `/.well-known/promovolve.txt` from a token stored in
`wp_options`. Since 0.5.0 that row survives plugin deletion (it is the last
copy of the token once a site is verified — see `project_wp_plugin_0_5_0`),
which closed the "reinstall wiped my integration" hole. It opened a small
one: a site **removed and re-added on Promovolve gets a new token**, and the
plugin has no way to learn that. It keeps serving the old one forever. The
dashboard's ownership re-check reports that as `foreign` — correct, but it
is the publisher reading a symptom, not the plugin knowing the fact.

The plugin already asks the server something once per admin page load
(`promovolve_verification_status`, via the serve endpoint's 403). That
answer cannot carry this: 403 means "unverified OR host mismatch OR no such
site", and acting on it would hit people mid-setup. A dedicated question
gets a dedicated answer.

## Non-goals

- **Deleting anything on the WordPress side.** The row holds values a human
  typed; the server never reaches into it. The only effect is whether the
  `.well-known` URL answers.
- **Gating serving.** Same rule as the dashboard re-check: taking a proof
  down after verification is legitimate. This changes what the plugin
  serves, never what the ad server serves.
- **A token oracle.** No endpoint answers "does token X exist?" for an
  arbitrary X. The question is always scoped to one site and the token is
  the thing being proven, not looked up.

## The endpoint

```
POST /v1/sites/{siteId}/token-check
Content-Type: application/json
{"token": "<the token the caller holds>"}

200 {"state": "valid"}      site exists and this IS its current token
200 {"state": "stale"}      site exists; this is NOT its current token
200 {"state": "unknown"}    no such site (or not initialised)
429                         rate cap — treat as unreachable
5xx / timeout               treat as unreachable
```

Always 200 for the three answers, so a caller cannot tell `stale` from
`unknown` by status code alone — deliberately: the two differ only in what
the plugin's settings screen says, and a caller probing for *existence*
gets no cheap signal.

Shape notes:

- **Token in the body, never the query string.** It is a credential; query
  strings land in access logs, proxies and Referers.
- **Keyed by `siteId`.** A site ID is not secret (it is in every page's
  `data-pub`), so the URL carries nothing new. Holding the token is the
  authentication, exactly as it is for the verification file itself.
- **Constant-time comparison** (`MessageDigest.isEqual`) of the token bytes.
- **Rate-limited** per client IP through its own
  `promovolve.fraud.RequestRateGate` (1/s, burst 10, bucket key
  `token-check:<ip>`, first `X-Forwarded-For` entry behind the ingress), on
  top of the per-site natural limit (one call per plugin per 5 minutes).
  The bucket is per api POD, so the effective burst is 10 × replicas —
  verified live 2026-08-22: a burst of 40 against two pods gave 20×200 and
  20×429. Generous for every real caller, still useless for a guesser.
- **No logging of the token.** Log `siteId` and `state` at debug only.
- Lives next to `getVerificationToken` / `verifySite` in `Endpoints.scala`
  (`sitesBase / path[String]("siteId") / "token-check"`) but is NOT under
  the publisher-authenticated `/publishers/me/` prefix — the caller is a
  site, not a logged-in user.

## Core

`SiteEntity` gains one read-only command:

```scala
final case class CheckVerificationToken(token: String, replyTo: ActorRef[TokenCheckResult]) extends Command
sealed trait TokenCheckResult extends CborSerializable
case object TokenValid   extends TokenCheckResult
case object TokenStale   extends TokenCheckResult
case object TokenUnknown extends TokenCheckResult
```

Handler: `state.verificationToken` absent or site uninitialised → `Unknown`;
present and equal (constant-time) → `Valid`; present and different →
`Stale`. `Effect.none`, no persistence, no side effects, no log above debug.
A deleted site (tombstone) answers `Unknown`.

`EndpointRoutes`: `tokenCheckLogic` asks the entity with the normal short
timeout; an ask failure maps to a 503 so the caller fails open.

## WordPress plugin (0.5.1)

`promovolve_token_status( $s )` — alongside the existing
`promovolve_verification_status`, same 5-minute transient, called from the
same places (settings screen render; and, new, from the `.well-known`
handler on a cache miss so a long-unvisited admin still converges):

| answer | `.well-known` | settings screen |
|---|---|---|
| `valid` | serve the file | "Token current." |
| `stale` | **404** (a real one — `status_header(404)`, not a fall-through to WordPress, which 301s to a trailing-slash page) | "This token is no longer the site's current one — usually the site was removed and re-added on Promovolve, which issues a new token. Paste the new one from the dashboard Sites page." |
| `unknown` | **404** | "Promovolve does not know a site with this ID — check the Site ID, or re-add the site on the dashboard." |
| unreachable / 429 / no transient yet | **serve the file** (fail open) | "Could not reach the ad server — serving the file as configured." |

Fail-open is load-bearing: the file is also how a *new* site gets verified,
so a server hiccup must never hide it. Suspension is computed, not stored:
the row is untouched, and the moment the server says `valid` again (new
token pasted, site re-added with the same token) the file is back with no
action on the WordPress side.

`promovolve_purge_page_caches()` clears the new transient too, so pasting a
new token takes effect immediately rather than after five minutes.

## Dashboard interplay

The ownership re-check (`CheckVerificationFile`) is unchanged. With this in
place its `foreign` state becomes rare — the plugin stops serving a stale
token instead of the dashboard reporting it — but the state stays, for
static files and other integrations that cannot ask.

## Tests

- `SiteEntity`: the three answers; tombstoned site → `Unknown`; comparison
  is byte-exact (case-sensitive, no trim).
- Route: token in body only (a `?token=` query is ignored, not honoured);
  429 under the gate; 503 on ask failure.
- Plugin (`topic-test.php` style, stubbing `wp_remote_post`): the four rows
  of the table above, fail-open on `WP_Error`, transient invalidated on save.

## Rollout

1. api: endpoint + entity command (additive; nothing calls it yet).
2. Plugin 0.5.1: probe + suspension. A 0.5.1 plugin against an api without
   the endpoint gets 404 → treated as unreachable → serves the file, i.e.
   today's behaviour. Safe in either order; api first is cleaner.

## Why `unknown` never deletes the row

The obvious follow-up — "if Promovolve says the site does not exist, the
plugin can remove its own data" — is rejected, and the reason is what
`unknown` actually covers. The server cannot distinguish:

- the site was genuinely removed on Promovolve (the case the idea is for);
- the publisher mistyped the Site ID and has not noticed yet;
- the site request is still awaiting operator approval — no `SiteEntity`
  exists yet, so the answer is `unknown` throughout setup;
- a transient during a rollout, before the entity has recovered.

In three of the four, deleting the row destroys the API base, script URL and
a token the publisher typed moments ago — the "plugin ate my integration"
failure 0.5.0 closed, re-opened through a new door. And removal buys only a
tidy row: the visible outcome (the file is gone) is already delivered by the
404. The publisher who is genuinely finished has an unambiguous, one-click
path — *Also delete these settings* + delete the plugin — that states the
intent rather than inferring it.

So the plugin acts on `unknown` in exactly two ways: it stops answering the
`.well-known` URL, and it **tells the publisher**.

## Persistent `unknown`: an admin notice, not a deletion

When `unknown` has been the answer continuously for **7 days** (tracked as a
`first_unknown_at` timestamp in the option, cleared by any other answer), the
plugin shows a dismissible WordPress admin notice on every admin page, not
just Settings → Promovolve:

> Promovolve no longer knows a site with this ID. If you have left
> Promovolve, delete this plugin with *Also delete these settings* ticked
> and nothing will be left behind. If you have not, check the Site ID under
> Settings → Promovolve, or re-add the site on the dashboard.

Seven days, not five minutes, because every benign cause above resolves well
inside a week (approval lands, the typo is fixed, the rollout finishes) and a
notice that fires during setup teaches publishers to dismiss it. Dismissal is
remembered per state change: it returns only if the answer flips to something
else and back to `unknown` again.

`stale` gets the same treatment with a shorter fuse — notice after **24
hours** — because its benign cause (a re-added site whose new token has not
been pasted yet) is something the publisher is actively in the middle of, and
a day is long enough to have forgotten.

## Open

- Nothing blocking. Whether the notices should also link straight to the
  dashboard Sites page (deep link needs the dashboard URL, which the plugin
  does not currently store — it knows only the ads API base).
