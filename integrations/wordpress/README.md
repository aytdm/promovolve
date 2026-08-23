# Promovolve Publisher — WordPress plugin

The connection layer between a WordPress site and a Promovolve ad server. It
lives in `integrations/wordpress/promovolve/` and ships as a copy-and-go
folder: three PHP files, one block, no build step, no Composer, no bundler.

| | |
|---|---|
| Plugin slug / text domain | `promovolve` |
| Current version | 0.5.3 (`promovolve.php` header, `PROMOVOLVE_VERSION`, `readme.txt` Stable tag — all three must agree, `build-zip.sh` enforces it) |
| Requires | WordPress 6.0+, PHP 7.4+ (declared in the header; see [Compatibility](#compatibility-and-known-gaps)) |
| License | Apache-2.0 (same as the repository) |
| Distribution | GitHub Actions artifact (`wp-plugin-build.yml`) or GitHub Release (`wp-plugin-release.yml`, public). Not on WordPress.org. |
| Publisher-facing summary | `promovolve/readme.txt`; [Publisher Integration guide → WordPress](../../docs/guides/publisher-integration.md#wordpress) |

This README is the complete reference: what the plugin does, exactly how,
what it stores, what it talks to, and how to develop, test, and ship it.
Everything stated here was checked against the plugin source, the ad server
(`modules/`), the ad tag (`platform/banner-bootstrap/`), or a live WordPress
at the time of writing (2026-08-23, plugin 0.5.3). Where something is a
design intention rather than verified behaviour, it says so.

---

## Contents

1. [What it does](#what-it-does)
2. [Install, upgrade, uninstall](#install-upgrade-uninstall)
3. [Settings reference](#settings-reference)
4. [How it works](#how-it-works)
   - [The ad tag](#1-the-ad-tag)
   - [Site verification and the token lifecycle](#2-site-verification-and-the-token-lifecycle)
   - [Ad slots](#3-ad-slots)
   - [Page context: topic and place hints](#4-page-context-topic-and-place-hints)
5. [Caching and cache purges](#caching-and-cache-purges)
6. [Everything the plugin stores](#everything-the-plugin-stores)
7. [Hooks and filters](#hooks-and-filters)
8. [What the plugin talks to](#what-the-plugin-talks-to)
9. [Security notes](#security-notes)
10. [Compatibility and known gaps](#compatibility-and-known-gaps)
11. [Development](#development)
12. [Troubleshooting](#troubleshooting)
13. [Version history](#version-history)

---

## What it does

Four things, all from one file (`promovolve.php`):

1. **Prints the ad tag** — `<script data-pub data-api [data-section]
   [data-place] src=…promovolve-ad.js>` in `<head>` of every front-end page,
   once Site ID, API base and script URL are all set.
2. **Serves the site-verification file** at `/.well-known/promovolve.txt`
   from the stored token — and *stops* serving it when the ad server says
   that token is no longer the site's.
3. **Places ad slots** three ways: a Gutenberg block, a shortcode, and an
   optional automatic slot after post content. Slot identity (`<id>_<w>x<h>`
   plus an optional per-category/per-post suffix) is derived here.
4. **Sends page context** the CMS knows as fact — the post's taxonomy terms
   as a topic hint and its place taxonomy terms (or `geo_address`) as a place
   hint — so the ad server can classify archives and place-specific articles
   better than from rendered text alone.

Plus an admin surface: **Settings → Promovolve** (connection, verification
with live checks, slots, page context, uninstall behaviour, a read-only
"Context this site sends" report) and two slow-burn admin notices.

What it deliberately does **not** do: derive anything from the visitor
(IP, profile, cookies), register slots with the server (slots self-enrol on
first serve), keep a place gazetteer (names go out, the server resolves
them), or delete its settings on uninstall by default.

---

## Install, upgrade, uninstall

**Install.** Plugins → Add New → Upload Plugin → the zip (or unzip the
`promovolve/` folder into `wp-content/plugins/`). Activate. Then:

1. Register the site (its URL) on the Promovolve dashboard and wait for
   operator approval.
2. Settings → Promovolve: paste **Site ID**, **Ads API base URL**, **Ad
   loader script URL** (all from the operator) and the **verification
   token** (dashboard → Sites → the site). Save.
3. Dashboard → Sites → **Verify**. The plugin is serving
   `/.well-known/promovolve.txt`; if the domain root never reaches WordPress
   (subdirectory install), use the DNS TXT fallback the settings page prints
   (`_promovolve.<host>` TXT `promovolve-site-verification=<token>`).
4. Place slots. Ads fill only after the site is approved *and* verified, and
   after each winning creative is approved in the publisher's Approval queue
   (or auto-approval is on). A brand-new page serves nothing on its first
   view(s) while it is classified — normal.

**Upgrade.** Plugins → Add New → Upload Plugin → *Replace current with
uploaded* (WordPress 5.5+). Settings are untouched. The
deactivate → delete → upload path also keeps settings by default (see
Uninstall).

**Uninstall** (`uninstall.php`, runs on *Delete*, not on deactivate):
- `promovolve_settings` is **kept** unless the "Also delete these settings
  when the plugin is deleted" box was ticked. Reason: once a site is
  verified the token is easy to lose and the dashboard's copy is behind a
  disclosure; the only recovery from a lost token used to be removing and
  re-adding the site, which is a full cascade purge.
- `promovolve_token_state` and the three transients are always deleted.

**Pausing without uninstalling:** deactivate the plugin. Nothing runs, the
option stays.

---

## Settings reference

All settings live in one option, `promovolve_settings` (autoloaded), saved
through the Settings API with `promovolve_sanitize_settings` as the
sanitizer. Defaults in `promovolve_settings()`.

| Key | UI | Sanitisation on save | Default |
|---|---|---|---|
| `site_id` | Site ID | lowercased, `[a-z0-9-]` only | `''` |
| `api_base` | Ads API base URL | `esc_url_raw`, trailing `/` stripped, trailing `/v1` stripped (the loader appends `/v1` itself) | `''` |
| `script_url` | Ad loader script URL | `esc_url_raw` | `''` |
| `verification_token` | Verification token | leading `promovolve-site-verification=` stripped (full line paste accepted), then `[A-Za-z0-9-]` only | `''` |
| `auto_slot_enabled` | Automatic slot after post content (checkbox) | bool | `false` |
| `auto_slot_id` | Slot ID base | `sanitize_text_field` | `article-footer` |
| `auto_slot_w` / `auto_slot_h` | Width / Height | `max(0, int)` — 0 renders nothing | `728` / `90` |
| `auto_slot_scope` | Automatic slot identity | one of `site` `category` `post` | `site` |
| `destination_taxonomy` | Page context → Destination taxonomy (checkbox) | bool | `false` |
| `delete_on_uninstall` | If you delete this plugin → Settings on delete (checkbox) | bool | `false` |

Checkboxes are read from the submitted form every save (an unchecked box is
absent from POST), so they can be un-ticked; the text fields fall through to
the stored value when absent.

Saving the option fires `promovolve_purge_page_caches()` (see
[Caching](#caching-and-cache-purges)) on both `add_option_promovolve_settings`
and `update_option_promovolve_settings` — the first save creates the row and
fires a different hook than later saves.

The settings screen also shows, read-only: the active tag as printed, the
live verification-file check, the token state, the DNS TXT fallback, the
derived automatic-slot ID, theme-aware placement advice (block theme vs
classic), and the "Context this site sends" report (which of the site's
taxonomies are read as topic / place, the full place-slug vocabulary folded
away, the `geo_address` fallback with examples, and the filter snippet).

---

## How it works

### 1. The ad tag

`wp_enqueue_scripts` enqueues handle `promovolve-ad` with `src = script_url`,
no dependencies, **version `null`** (so no `?ver=` is appended — the loader
URL is a stable alias that must stay byte-addressable; the CI publish job
writes it to R2 with `max-age=300`, see `.github/workflows/deploy.yml`),
printed in `<head>`. Nothing is enqueued until `site_id`, `api_base` and
`script_url` are all non-empty.

A `script_loader_tag` filter then rewrites the tag so the attributes sit on
the real `<script src>` element — the loader reads `document.currentScript`
at install time and later reads `dataset.pub`, `dataset.api`,
`dataset.section`, `dataset.place` from that captured element
(`platform/banner-bootstrap/src/bootstrap.ts`, `autoDisplay`). The splice
replaces only the **first** ` src=` (a `preg_replace_callback` with limit 1 —
a replacement *string* would interpret `$1`/`\1` inside a publisher URL).

Result, for a post filed under "Travel" + "Onsen" and destination "Kinosaki
Onsen":

```html
<script data-pub="example-com" data-api="https://ads.example.com"
        data-section="Travel, Onsen, Kinosaki Onsen" data-place="Kinosaki Onsen"
        src="https://cdn.example.com/promovolve-ad.js"></script>
```

`data-section` / `data-place` are omitted when empty. What the loader does
from there (slot discovery on `DOMContentLoaded`, one
`POST /v1/serve/batch`, on-demand `POST /v1/classify-page` with the hints
riding along) is the ad tag's business, documented in
[publisher-integration.md](../../docs/guides/publisher-integration.md) and
`docs/design/ON_DEMAND_CLASSIFICATION.md`.

If `data-api` were missing, the loader falls back to the page's own host on
port 8080 — a dev convenience, which is why the plugin refuses to print the
tag without an API base.

### 2. Site verification and the token lifecycle

**The file.** An `init` (priority 1) hook inspects `REQUEST_URI`; when its
path is exactly `/.well-known/promovolve.txt` and a token is stored, it
answers `200 text/plain` with `promovolve-site-verification=<token>` and
exits. No rewrite rules, no filesystem writes, `nocache_headers()`. With no
token stored it returns and lets WordPress handle the URL as usual.

**Stopping the file when the token is not the site's.** Since 0.5.1 the
handler first asks `promovolve_token_status()`:

| State | Meaning (from `POST {api_base}/v1/sites/{site_id}/token-check`, body `{"token": …}`) | Verification file |
|---|---|---|
| `valid` | the stored token is the site's current one | served |
| `stale` | the site exists but has a different token (removed and re-added on Promovolve) | **real 404** |
| `unknown` | the server knows no site with that ID (never created, awaiting approval, removed, typo) | **real 404** |
| `unreachable` | anything else: network error, 429 (the endpoint is rate-gated per IP), 5xx/503, a pre-2026-08-22 server without the endpoint (404), malformed body — *or* no site_id/api_base/token to ask with | served (**fails open** — this URL is also how a brand-new site gets verified) |

"Real 404" = `status_header(404)` + `exit`, not a fall-through. Verified on
WordPress 6.9.4 with plain permalinks: an unclaimed `/.well-known/*.txt` is
answered by WordPress with a `301` to the trailing-slash URL, which reads as
a broken redirect to anyone probing; the explicit 404 is the honest answer.

The answer is cached in transient `promovolve_token_status` for **5 minutes**
and dropped on every settings save, so a freshly pasted token is re-checked
on the next request. **Nothing is ever deleted by this check** — `unknown`
also covers "still in the approval queue" and "mistyped ID". The stored
value is untouched; the 404 is computed from the cached answer.

Note this check runs on a **front-end request** (the `.well-known` hit) when
the cache is cold, with a 5 s timeout; the rest of the plugin's server calls
happen only in wp-admin. Spec and server half: `docs/design/SITE_TOKEN_CHECK.md`.

**Slow-burn bookkeeping** (`promovolve_token_state`, option, not autoloaded):
`{state, since, dismissed}`. `since` resets on *every* state change,
including to `unreachable`, so a server hiccup cannot keep a countdown
running. `promovolve_record_token_state()` is a no-op when the state is
unchanged, so `since` and a dismissal survive.

**Admin notices** (`admin_notices`, `manage_options` only): after the state
has been `unknown` for **7 days** or `stale` for **24 hours**, a dismissible
warning names the cause and the fix (paste the current token; check the Site
ID; or — for a publisher who has genuinely left — delete the plugin with the
settings checkbox ticked). Dismissal is stored per state change; the notice
returns only if the answer flips away and back. The dismiss link is
nonce-protected (`check_admin_referer`) and redirects back without the query
args. Not on first sight, deliberately: every benign cause resolves well
inside the fuse, and a notice that fires during setup teaches publishers to
dismiss notices.

**"Is this site verified?"** (`promovolve_verification_status`, settings
page only, transient `promovolve_verification_status`, 5 min): the plugin
POSTs `{pub, url: home_url('/'), imp: []}` to `{api_base}/v1/serve/batch`.
The ad server's `BatchSelect` handler replies:

- **403** → `unverified`. On the server this is `BatchHostNotVerified`:
  the page URL's host did not match the site's verified host. That covers
  three situations, not two: the site is unverified, the host is different,
  **or the AdServer entity does not yet know a verified host** (right after
  an api restart, before the DData publish lands) — so a 403 can be a
  transient false negative, cached for up to 5 minutes.
- **200 / 204** → `verified`. 200 with an empty `imp` passes the gate, does
  no auction, enrols no slot, reserves no budget (`slots.isEmpty` →
  `BatchSelected(Vector.empty)`); it does count as one request arrival. 204
  is `BatchSiteSuspended` (operator-suspended org) — **but the server checks
  suspension before the host gate**, so a 204 does not actually prove the
  host is verified; the plugin currently treats it as verified (see
  [Known gaps](#compatibility-and-known-gaps)).
- anything else / network error → `unknown`.

The verified branch of the settings page says so in green and **keeps the
token field visible**, marked optional (0.5.2): verification is one-time
and held server-side, but keeping the token filled is what makes the plugin
answer the verification URL, which the dashboard re-checks (advisory only —
never a serving gate) when the site's details are opened.

**"What does the world actually see?"** (`promovolve_wellknown_status`,
settings page, unverified branch, transient `promovolve_wellknown_status`,
1 min): a loopback `GET home_url('/.well-known/promovolve.txt')` with
`redirection => 2`. States: `serving` (200 and the token found equals the
stored one), `foreign` (200 with *some other* token — a static file or a
previous install is answering; verification will work as-is), `missing`
(anything else, including an HTML catch-all 200 — the body is grepped, not
just the status), `unknown` (the request itself failed; many hosts block
loopback — the page says to open the URL in a browser instead).

### 3. Ad slots

All three placement methods emit the same container through
`promovolve_slot_html()` / `promovolve_render_slot_block()`:

```html
<div style="display:block;width:100%;max-width:300px;aspect-ratio:300/250;margin:16px auto;"
     data-promovolve-slot="in-content_300x250" data-w="300" data-h="250"></div>
```

The inline style is the size contract the ad tag expects — the container is
authoritative for the rendered ad's size (fill the column *up to* the
declared width, keep the aspect ratio, centre); a bare `div` would stretch to
the theme's content column and a 300×250 rendered ~700 px wide.

**Identity rules**

| Placement | Effective `data-promovolve-slot` | Notes |
|---|---|---|
| Shortcode `[promovolve_slot id="x" w= h= class=]` | `x` **verbatim** | Hand-written IDs are already inventory rows; rewriting them would orphan existing slots. `class` is passed through `esc_attr`. |
| Block `promovolve/slot` | `<slotId>_<w>x<h>` + scope suffix | `slotId` sanitised to `[a-z0-9-]` on both sides (editor and PHP). Dynamic block: `save()` returns `null`, PHP renders, so markup changes never invalidate saved posts. |
| Automatic slot | `<auto_slot_id>_<w>x<h>` + scope suffix | Appended to `the_content` on `is_singular() && in_the_loop() && is_main_query()` only. Note: that is every singular view (posts, pages, custom post types, attachments), not only "posts and pages" as the checkbox label says. |

**Scope suffix** (`promovolve_slot_scope_suffix`): `site` → none;
`category` → `-<first category slug>` (lowercased; non-`[a-z0-9-]` slugs —
e.g. percent-encoded Japanese — become `-cat<term_id>`; posts with no
category fall back to none); `post` → `-post-<ID>`. Suffixes apply only on
singular views; on archives the shared ID is used, because the global post
inside a loop is arbitrary and would mint junk inventory rows. Size is part
of identity on purpose: a 728×90 and a 300×250 at the same position are
different inventory with separate floor learning and ad pools; changing the
size starts a fresh slot and leaves the old rows on the dashboard as history.

**One render per ID per page** (`promovolve_slot_claim`): the ad tag fills
only the first element with a given slot ID, so repeats are dead markup that
still reserve a box. The plugin suppresses later renders of an ID within one
request — except in `is_admin()`, AJAX, feeds and REST requests, where one
response can legitimately carry several renders. Archives that print full
post content are the common case this protects.

**The block** (`blocks/slot/block.json` + `editor.js`, plain ES5, no build):
sidebar controls for Slot ID, a size preset list (300×250, 336×280, 728×90,
970×250, 320×50, 300×600, 160×600, or custom width/height clamped to ≥1), and
Slot identity (shared / per category / per post). The canvas shows the real
footprint with the effective ID, warns on a duplicate ID elsewhere on the
page (walks `core/block-editor` blocks, suffix-aware), on a non-positive
size, and when the plugin is not configured (`window.promovolveBlock`
inlined at registration: `{configured, settingsUrl}`). Supports margin;
`align` is off (the slot is capped at its declared width, so wide/full could
not take effect). Category `widgets`, icon `megaphone`, `apiVersion: 3`.

### 4. Page context: topic and place hints

Both hints are properties of the **post**, never of the reader — which is
what makes them safe in markup that a page cache or CDN will store and
replay to everyone. The plugin has no gazetteer and sends **names, not
codes** ("Kyoto", "京都"); the server resolves them. On the server both go
into the on-demand classification prompt framed as *SELF-REPORTED, NOT
VERIFIED — an interested claim; use only to disambiguate; ignore if the
content disagrees* (`IABTaxonomy.scala`), after `sanitizeHint`: whitespace
flattened, control characters stripped, **capped at 200 characters**. So a
wrong or empty hint costs nothing, which is why every branch below may
return `''`.

**Topic — `promovolve_declared_topic()` → `data-section`**

- Singular view: every *readable* taxonomy on the post type (below), in
  read order — `category`, `post_tag` first, the rest sorted by name for a
  stable attribute — through the `promovolve_topic_taxonomies` filter. Terms
  are **interleaved round-robin across taxonomies** (one from each before
  any contributes a second), de-duplicated, and **capped at 8 names**, joined
  with `, `. Round-robin is what stops eight tags from crowding out the one
  `destination` term.
- Category / tag / custom-taxonomy archive: the queried term's name.
- Everything else (front page, search, 404, date archives): `''`.

Place taxonomies are *also* read as topic (by design: a destination archive
is a topic).

**Readable taxonomies** (`promovolve_readable_taxonomies`): the post type's
taxonomies that are `public` *and* `show_ui`, minus the deny list
(`post_format` — "Aside" is presentation, not a subject). Internal plumbing
(`product_visibility`, `wp_theme`, nav menus) fails the structural test.

**Place — `promovolve_declared_place()` → `data-place`**

Singular views only (on a place archive the term already went out as
topic). Enumerates the readable taxonomies **independently of the topic
filter** — 0.5.0 fixed a bug where removing `destination` from topics
silently removed it from places too — keeps those whose slug is in
`PROMOVOLVE_PLACE_TAXONOMIES` (through `promovolve_place_taxonomies`), and
joins their term names with the same interleave/cap. If **no** place
taxonomy term exists, it falls back to the post meta `geo_address` (free
text, WordPress's own geodata convention; `geo_latitude`/`geo_longitude`
are deliberately not read).

The place slug vocabulary (matched on slug, not label — `行き先` works if
registered under one of these): administrative units (`country`, `state`,
`province`, `prefecture`, `region`, `county`, `municipality`, `city`, `town`,
`village` and plurals), generic wording (`destination`, `location`, `place`,
`area`, `locality` and plurals), sub-city units that the server resolves up
to the containing city/subdivision (`district`, `neighborhood`/`neighbourhood`,
`borough`, `suburb`, `island` and plurals), and slugs shipped by common
plugins/themes where the term is the page's subject (`job_listing_region`,
`travel_locations`, `tour_location`, `listing_city`, `listing_region`,
`listing_location`, `property_city`, `property_state`, `property_country`,
`property_area`). Store-locator / local-SEO taxonomies are deliberately
absent: they hold the publisher's own address. `PROMOVOLVE_PLACE_TAXONOMY_GROUPS`
is the same list grouped for display; `tests/topic-test.php` fails if the
two drift. The recommended slug for a site with none is `destination`.

**Built-in Destination taxonomy** (0.5.3, `destination_taxonomy` setting,
off by default): on `init` priority 5, if the option is on *and*
`taxonomy_exists('destination')` is false, registers a non-hierarchical,
public, `show_ui`, `show_in_rest` (that is what puts the box in the block
editor sidebar), `show_admin_column` taxonomy `destination` on the `post`
type only, rewrite slug `destination`. Switching it off later hides the box;
WordPress keeps the terms (unregistering never deletes term data). A site
that already has a `destination` taxonomy is left alone.

**Context report** (`promovolve_context_taxonomies`, settings page): the
site-wide answer to "does this site have a place taxonomy at all?" — every
public+`show_ui` taxonomy across all post types, split into place/topic by
the same slug test. Per-post render-time reads remain the authority; this
mirrors their rules.

---

## Caching and cache purges

`promovolve_purge_page_caches()` runs on every save of `promovolve_settings`
(both option hooks). It:

1. deletes the three transients (`promovolve_wellknown_status`,
   `promovolve_verification_status`, `promovolve_token_status`) so the live
   checks and the token check re-run immediately with the new values;
2. purges every page cache it can detect — LiteSpeed (`litespeed_purge_all`),
   WP Super Cache, W3 Total Cache, WP Rocket, SiteGround Optimizer, WP
   Fastest Cache, Cache Enabler, Breeze, Hummingbird, WP-Optimize — each
   guarded by `function_exists`/`class_exists` or a `do_action` nobody
   listens to, so absent plugins are no-ops;
3. calls `wp_cache_flush()` — the **whole** persistent object cache, if one
   is installed (see [Known gaps](#compatibility-and-known-gaps)).

Why: the tag and slot IDs are in cached HTML. On Hostinger, LiteSpeed cached
pages for 7 days and silently ate a settings change until a manual purge.
External caches/CDNs (Cloudflare page cache, host-level caches) must still be
purged by hand; the settings page says so.

`promovolve_token_state` is a **separate option**, not a key inside
`promovolve_settings`, precisely so that the plugin's own periodic
bookkeeping does not trigger this purge.

---

## Everything the plugin stores

| Where | Key | Autoload | Content | Lifetime |
|---|---|---|---|---|
| option | `promovolve_settings` | yes | all settings (table above) | kept on uninstall unless `delete_on_uninstall` |
| option | `promovolve_token_state` | **no** | `{state, since, dismissed}` for the notices | deleted on uninstall |
| transient | `promovolve_token_status` | — | `valid\|stale\|unknown\|unreachable` | 5 min; dropped on settings save |
| transient | `promovolve_verification_status` | — | `verified\|unverified\|unknown` | 5 min; dropped on settings save |
| transient | `promovolve_wellknown_status` | — | `{state, token, code}` | 1 min; dropped on settings save |
| taxonomy terms | `destination` (only if the built-in taxonomy was enabled and used) | — | WordPress term data | never touched by the plugin |

No post meta is written; `geo_address` is only read. No cookies, no
front-end storage (the ad tag's dog-ear bookmarks live in the browser's
IndexedDB with a default 7-day TTL capped at the campaign's end — that is the
tag, not the plugin).

---

## Hooks and filters

**Filters the plugin exposes**

| Filter | Args | Purpose |
|---|---|---|
| `promovolve_topic_taxonomies` | `string[] $taxonomies, int $post_id` | Narrow/reorder the taxonomies read for `data-section`. Does **not** affect places. |
| `promovolve_place_taxonomies` | `string[] $slugs, int $post_id` (`0` from the settings page) | Add/remove taxonomy slugs treated as places for `data-place`. The settings page lists any slugs added this way under "Added on this site by a filter". |

```php
add_filter( 'promovolve_place_taxonomies', function ( $slugs ) {
	$slugs[] = 'spot';
	return $slugs;
} );
```

**WordPress hooks the plugin attaches to** (all in `promovolve.php`):
`wp_enqueue_scripts`, `script_loader_tag` (10, 2), `init` ×3 (priority 1
verification file; 5 destination taxonomy; 10 block registration),
`the_content` (automatic slot), `add_shortcode('promovolve_slot')`,
`admin_init` ×2 (`register_setting`; notice dismiss), `admin_menu`,
`admin_notices`, `add_option_promovolve_settings`,
`update_option_promovolve_settings`, `plugin_action_links_<basename>`
(Settings link). Shortcode, block and the `the_content` filter are the only
front-end output besides the tag and the verification file.

---

## What the plugin talks to

| Call | From | When | Contract |
|---|---|---|---|
| `POST {api_base}/v1/sites/{site_id}/token-check` body `{"token"}` | server side (WP) | `.well-known` hit with cold cache (front end); settings page | 200 `{"state":"valid\|stale\|unknown"}` (always 200 for a known/unknown site — no existence oracle); 429 per-IP rate gate (1/s, burst 10); 503 on server-side ask failure; older server → 404. Anything but a 200 with a recognised state = `unreachable`. Token in the **body**, never the URL. `timeout 5`. |
| `POST {api_base}/v1/serve/batch` body `{pub, url: home_url('/'), imp: []}` | server side (WP) | settings page only | 200/204 = verified, 403 = unverified (or host unknown yet), else unknown. Empty `imp` → no auction, no slot enrolment, no budget reservation; counts as one arrival. `timeout 5`. |
| `GET home_url('/.well-known/promovolve.txt')` | server side (WP), loopback | settings page, unverified branch | What the world sees. `redirection 2`, `timeout 5`. Loopback is commonly blocked → `unknown`, not `missing`. |
| `{script_url}` (the ad tag) | the visitor's browser | every front-end page | The loader then calls `{api_base}/v1/serve/batch`, `/v1/classify-page` (page text + the two hints), beacons. Not plugin code. |

Requires an ad server from 2026-08-22 or later (`dbf744b`) for the token
check; against an older one the plugin behaves exactly like 0.5.0 (file
always served).

---

## Security notes

- Settings form: Settings API + `settings_fields('promovolve')` nonce;
  `manage_options` for the page, the notices and the dismiss action; the
  dismiss link is `wp_nonce_url` + `check_admin_referer`.
- Output: every attribute/text through `esc_attr`/`esc_html`/`esc_url`;
  the token is restricted to `[A-Za-z0-9-]` on save and echoed into a
  `text/plain` body; `get_block_wrapper_attributes()` is core-escaped; the
  tag splice uses a callback, not a replacement string.
- The verification-file handler never touches the filesystem and matches the
  exact path only.
- Site ID restricted to `[a-z0-9-]`; it is interpolated into the token-check
  URL with `rawurlencode` anyway.
- Outbound requests go only to the admin-configured `api_base` and to the
  site's own `home_url`. The token travels in a POST body over whatever
  scheme `api_base` uses — use `https://`.
- Nothing reader-specific is ever printed into markup (see the place hint
  design note: a per-visitor value would be captured by the page cache and
  served to the world).

---

## Compatibility and known gaps

Verified environments: Docker WordPress 6.9.4 (plain permalinks, PHP 8.3,
Apache) and a Hostinger shared host (WordPress 7.0.x, LiteSpeed). The
header says WP 6.0 / PHP 7.4; a scan of the PHP files finds no PHP 8-only
syntax (`fn`, `match`, `?->`, `str_contains`, enums), but nothing runs it
under 7.4 — the build's `php -l` uses whatever PHP the machine or CI runner
has. **Untested below WP 6.3:**
`block.json` declares `apiVersion: 3` (the iframed editor API introduced in
6.3); what 6.0–6.2 do with it has not been checked.

Known gaps / open points (as of 0.5.3):

1. **`promovolve_verification_status` treats HTTP 204 as "verified".** On
   the server, operator suspension is checked *before* the host gate
   (`AdServer.scala`, `BatchSelect`: `siteSuspended` → `BatchSiteSuspended`
   first, then `hostMatches`), so a suspended-and-unverified site would be
   reported verified. Edge case; the honest mapping is 204 → `unknown`. The
   comment in the code currently states the opposite ordering.
2. **`wp_cache_flush()` in the purge** flushes the entire persistent object
   cache (Redis/Memcached) of the site — and of every site sharing that cache
   without key prefixes — on every settings save. It is also unnecessary for
   its stated purpose (`update_option` already refreshes the option's own
   cache entry). Candidate for removal.
3. **i18n is scaffolded but inert:** text domain `promovolve` is declared and
   every string is wrapped, but no `languages/` directory or `.mo` files ship
   and nothing calls `load_plugin_textdomain`. Translations would load only
   if someone dropped `wp-content/languages/plugins/promovolve-<locale>.mo`
   in place.
4. **Stale comments** from before 0.5.0/0.5.2 remain in `promovolve.php`:
   the `promovolve_wellknown_status` docblock still says uninstall deletes
   the option; the verification-status cache comment still says the cache
   "decides whether the token field appears at all"; the closing
   `endif; // 'verified' hides the token field entirely`; the
   `promovolve_settings()` `@return` shape lacks `auto_slot_scope`,
   `destination_taxonomy`, `delete_on_uninstall`.
5. **`readme.txt` "What data does the tag collect?"** still says "Visitors
   sending the Global Privacy Control signal receive no ads." The ad server
   has served under `Sec-GPC: 1` since 2026-08-12 (`ServeRoutes.scala`,
   `modules/api/src/main/scala/promovolve/api/GPC.md`: no viewer identity is
   held, so there is nothing GPC could opt out of). The readme must be
   corrected before the next release.
6. The automatic slot checkbox says "single posts and pages"; the code
   appends on every `is_singular()` view (custom post types and attachments
   included).
7. The built-in `destination` taxonomy is registered on `post` only; pages
   and custom post types cannot use it without a filter of their own.
8. The 403 probe can be a transient false negative right after an ad-server
   restart (verified host not yet known to the entity), cached for up to
   5 minutes.

---

## Development

**Layout**

```
integrations/wordpress/
├── promovolve/                 # the plugin — this folder is what ships
│   ├── promovolve.php          # everything: tag, verification, slots, hints, settings
│   ├── uninstall.php
│   ├── readme.txt              # WordPress.org-style readme + changelog (release notes come from here)
│   └── blocks/slot/{block.json,editor.js}
├── tests/topic-test.php        # topic/place hint rules, no WordPress needed
├── tests/token-test.php        # token-check state machine, fail-open, cache, bookkeeping
├── build-zip.sh                # version gate + php -l + tests + node --check → dist/promovolve-<v>.zip
├── docker-compose.yml          # throwaway WP on :8088 with the plugin bind-mounted
└── dist/                       # gitignored build output
```

**Local WordPress.** `docker compose up -d` → http://localhost:8088 (run the
installer once; `docker compose down -v` discards everything). The plugin
directory is **bind-mounted**, so edits are live on refresh. Two rules:
never use WordPress's *Delete* on the plugin in this WP (it `rm -rf`s the
mounted source); hard-reload the editor after touching `editor.js` (the
script is versioned by `PROMOVOLVE_VERSION`, not mtime). `WORDPRESS_DEBUG=1`
surfaces notices instead of a white screen. Testing uninstall without
deleting: `docker compose exec wordpress php -r 'define("WP_UNINSTALL_PLUGIN",true); require "/var/www/html/wp-load.php"; include "/var/www/html/wp-content/plugins/promovolve/uninstall.php";'`.
To exercise the verified branch or the token states without a real ad
server, an mu-plugin with a `pre_http_request` filter can stub `/v1/serve/batch`
and `/token-check` responses.

**Tests.** `php tests/topic-test.php` and `php tests/token-test.php` — each
stubs the handful of WordPress functions the plugin calls, includes
`promovolve.php`, and asserts behaviour. `topic-test.php` pins which
taxonomies are read, in what order, the interleave, the 8-name cap, the
place/topic independence, `geo_address`, and that the grouped place list
equals the flat one. `token-test.php` pins the three server answers → three
states, everything else → `unreachable` (fail open), cache honoured and
dropped on save, `since` resets on every change, and token-in-body. Both
need `MINUTE_IN_SECONDS`/`DAY_IN_SECONDS` defined before including the plugin.
No PHP locally? `docker run --rm -v "$PWD":/w -w /w php:8.2-cli php tests/topic-test.php`.

**Build.** `./build-zip.sh` → `dist/promovolve-<version>.zip`. It refuses to
build when the header `Version:`, `PROMOVOLVE_VERSION` and readme `Stable
tag:` disagree (a stale constant means editors keep the old cached
`editor.js`), runs `php -l` on every PHP file, both test scripts, `node
--check` on JS and a `block.json` parse, zips the *directory* (single
top-level `promovolve/` folder, `-X` to drop macOS forks), then verifies the
archive has no `__MACOSX` and contains `promovolve/promovolve.php`. Missing
`php`/`node` **fails** the build; `PROMOVOLVE_ALLOW_UNVERIFIED=1` overrides
and labels the result unverified.

**CI.**
- `.github/workflows/wp-plugin-build.yml` — manual dispatch, `contents:
  read`, runs `build-zip.sh`, unpacks the zip and uploads the *directory* as
  artifact `promovolve-plugin-<version>` (uploading the zip itself produced a
  zip-in-zip that WordPress rejects with "No valid plugins were found"). Use
  this to get an installable zip without publishing anything.
- `.github/workflows/wp-plugin-release.yml` — on tag `wp-v<version>` or
  manual dispatch, `contents: write`; **publishes publicly** (the repo is
  public). Guards tag == `wp-v<plugin version>`, extracts the version's
  changelog block from `readme.txt` (first `= x.y.z =` match — keep
  *Upgrade Notice* after *Changelog*), creates/updates the Release and
  attaches the zip idempotently.
- The cluster deploy (`deploy.yml`) never touches the plugin, and the plugin
  release never rolls the cluster.

**Releasing a new version.** Bump the three version strings; add a
`= x.y.z =` block under `== Changelog ==` (and an *Upgrade Notice* if
installation needs words); run `./build-zip.sh`; verify in the Docker WP
(settings page renders without PHP notices, tag present, `.well-known`
answers, block inserts); then either dispatch the build workflow for an
artifact or push tag `wp-vx.y.z` for a public release. Keep `readme.txt`
factual: it is the publisher's description of what the tag does.

**Conventions.** WordPress coding style (tabs, Yoda conditions, spaced
parentheses), every string through `__()`/`esc_html__()` with domain
`promovolve`, `phpcs:ignore` only with a reason, comments that state what
the code does and why — verify claims about WordPress core or the ad server
against the source before writing them down.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| No tag in the page source | All three connection fields set? Page cache purged (external CDN too)? View source, not DevTools — some optimisers relocate scripts. |
| Tag present, no ads | Site approved *and* verified? Creatives approved in the Approval queue? New page → first view classifies. Dashboard → Sites → Integration health: `no_slots` = theme stripped the markup, `no_fill` = healthy. |
| `/.well-known/promovolve.txt` → 404 | Token empty? Token `stale`/`unknown` (settings page says which — paste the current token from dashboard → Sites → the site → Verification token)? Subdirectory install → DNS TXT fallback. LiteSpeed may cache the 404 — add `?nocache=1` when probing. |
| `/.well-known/promovolve.txt` → 301 to `…txt/` | The plugin is not answering at all (deactivated, or no token stored) and WordPress is canonical-redirecting. |
| Settings page says "verified" but the dashboard says the file is missing | Expected: verification is one-time. Keep the token filled if you want the URL to answer; the dashboard check is advisory. |
| Settings page says "unverified" right after an ad-server deploy | Transient false negative (host not yet known to the entity); wait 5 minutes or save settings to drop the cache. |
| Live check says "could not reach" | Host blocks loopback; open the URL in a browser. |
| Block shows "Duplicate ID on this page" | Two blocks resolve to the same `<id>_<w>x<h>` + suffix; only the first fills. Change ID, size, or scope. |
| Slot renders nothing | ID empty, width/height ≤ 0, or a repeat of an ID already rendered in this request. |
| Place not sent for a post | Is the taxonomy slug in the vocabulary (Settings → Promovolve → Context this site sends)? Add it with `promovolve_place_taxonomies`, tick the built-in Destination taxonomy, or set `geo_address`. Place is singular-only. |
| Settings change "does not apply" | Page cache. Saving purges known plugins; CDNs/host caches are manual. |

---

## Version history

Full changelog in `promovolve/readme.txt`. Milestones: **0.1.0** tag +
verification file + shortcode + automatic slot with identity scope · **0.1.1**
first-save purge + wider cache coverage · **0.1.2** size in slot identity ·
**0.1.3** inline slot sizing · **0.2.0** the editor block + one-render-per-ID ·
**0.2.1** live verification/`.well-known` checks · **0.2.2** `data-section` ·
**0.3.0** every public taxonomy, round-robin, cap 8, `promovolve_topic_taxonomies` ·
**0.4.0** `data-place` + `geo_address` + `promovolve_place_taxonomies` ·
**0.5.0** settings survive delete, place/topic decoupled, context report,
unverified-build guard · **0.5.1** token check → 404 on stale/unknown, notices ·
**0.5.2** token field stays on verified sites · **0.5.3** built-in Destination
taxonomy. Only `wp-v0.2.2` exists as a public GitHub Release; later versions
were distributed as workflow artifacts.
