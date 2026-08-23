# Promovolve Publisher plugin — developer reference

This document is for people **working on the plugin**: reading it, changing
it, testing it, releasing it. It explains the architecture, maps every
function and hook, walks each request path, specifies the state machines and
the ad-server contracts, lists the WordPress behaviours the code leans on (and
the ones that bit), and gives recipes for extending it.

It is not the publisher manual. Publishers get `promovolve/readme.txt` (what
ships in the zip; its Changelog is also the release notes) and the WordPress
section of [`docs/guides/publisher-integration.md`](../../docs/guides/publisher-integration.md).
Server-side design lives in `docs/design/` — `SITE_VERIFICATION.md`,
`SITE_TOKEN_CHECK.md`, `ON_DEMAND_CLASSIFICATION.md`, `GEOGRAPHIC_CONTEXT.md`.

Everything here was checked against plugin 0.5.4, the ad server in this
repository (`modules/`), the ad tag (`platform/banner-bootstrap/`), CI, and a
live WordPress on 2026-08-23. Where a statement is a design intention or an
unverified assumption, it says so explicitly.

---

## Contents

1. [Architecture](#1-architecture)
2. [Repository layout](#2-repository-layout)
3. [Code map](#3-code-map)
4. [Lifecycles: what runs when](#4-lifecycles-what-runs-when)
5. [State and data](#5-state-and-data)
6. [Specifications](#6-specifications)
   - 6.1 [Slot identity](#61-slot-identity)
   - 6.2 [Context hints (topic, place)](#62-context-hints-topic-place)
   - 6.3 [Verification file and token check](#63-verification-file-and-token-check)
   - 6.4 [Settings sanitisation](#64-settings-sanitisation)
7. [Ad-server and dashboard contracts](#7-ad-server-and-dashboard-contracts)
8. [WordPress behaviours this code depends on](#8-wordpress-behaviours-this-code-depends-on)
9. [Security model](#9-security-model)
10. [Extending the plugin — recipes](#10-extending-the-plugin--recipes)
11. [Testing and verification](#11-testing-and-verification)
12. [Build, versioning, CI, release](#12-build-versioning-ci-release)
13. [Compatibility policy](#13-compatibility-policy)
14. [Known gaps and open issues](#14-known-gaps-and-open-issues)
15. [Lessons already paid for](#15-lessons-already-paid-for)
16. [Glossary](#16-glossary)

---

## 1. Architecture

### Where the plugin sits

```
                    WordPress (PHP, server side)                    visitor's browser
┌───────────────────────────────────────────────┐        ┌───────────────────────────────┐
│ promovolve.php                                │  HTML  │ <script data-pub data-api     │
│  • prints the ad tag + context attributes ────┼──────▶ │   data-section data-place     │
│  • emits slot containers (block/shortcode/    │        │   src=…promovolve-ad.js>      │
│    auto) with derived slot IDs                │        │ <div data-promovolve-slot …>  │
│  • answers /.well-known/promovolve.txt        │        │  loader (bootstrap.ts):       │
│  • settings page, notices                     │        │   POST /v1/serve/batch        │
└──────────┬─────────────────┬──────────────────┘        │   POST /v1/classify-page      │
           │ wp_remote_*     │ wp_remote_get (loopback)  │     (text + section + place)  │
           ▼                 ▼                           │   beacons                     │
┌──────────────────────┐  ┌────────────────────┐         └──────────────┬────────────────┘
│ ad server (api)      │  │ this site's own    │                        │
│ POST /v1/sites/{id}/ │  │ /.well-known/…     │                        ▼
│   token-check        │  └────────────────────┘         ┌───────────────────────────────┐
│ POST /v1/serve/batch │◀────────────────────────────────│ ad server (api) — auction,    │
│   (imp: [] probe)    │                                 │ classification (hints framed  │
└──────────┬───────────┘                                 │ as unverified), enrolment     │
           │                                             └───────────────────────────────┘
           ▼
┌──────────────────────┐   Verify button: fetches /.well-known/promovolve.txt, then DNS TXT.
│ dashboard (platform) │   Site details: advisory ownership re-check; token disclosure.
└──────────────────────┘
```

Three parties touch the same facts — the plugin, the ad tag, the ad server —
and the plugin is the **least trusted** of them by design: everything it
sends is treated server-side as a publisher-controlled claim.

### The four jobs

| Job | Entry points | Output |
|---|---|---|
| Ad tag | `wp_enqueue_scripts`, `script_loader_tag` | one `<script>` in `<head>` with `data-pub`, `data-api`, optional `data-section`/`data-place` |
| Verification file | `init` @1 | `200 text/plain promovolve-site-verification=<token>`, or a real `404` when the token is not the site's |
| Slots | block `promovolve/slot`, shortcode `[promovolve_slot]`, `the_content` filter | `<div data-promovolve-slot="…" data-w data-h style=…>` with the derived ID |
| Context hints | computed inside the `script_loader_tag` filter | `data-section` (topic names), `data-place` (place names) |

plus the admin surface (Settings → Promovolve, two slow-burn notices,
Settings link on the Plugins list).

### Design principles (the "why" behind most of the code)

1. **A property of the page, never of the reader.** Everything printed into
   HTML must be identical for every visitor, because page caches and CDNs
   replay it to the world. This is why the place hint comes from the post's
   taxonomy terms and never from an IP, and why nothing reader-specific is
   ever derived server-side in PHP.
2. **Names, not codes.** The plugin has no gazetteer and must not grow one.
   It sends "Kyoto" / "京都"; the ad server resolves names against a
   vocabulary it controls. A publisher-supplied ISO code would be an
   unverified value dressed as an authoritative one.
3. **Hints are evidence, never answers.** `data-section`/`data-place` go
   into the server's classification prompt framed as *self-reported, not
   verified, interested claim* and are capped/sanitised there. Every branch
   in the hint code may return `''` at zero cost.
4. **Never delete on inference.** The token check can 404 the verification
   file but never touches `wp_options`; uninstall keeps the settings unless
   the publisher opts in; notices point at the explicit path instead of
   guessing intent. The token is often the *last copy* once a site is
   verified.
5. **Fail open where the alternative hides a new site.** An unreachable ad
   server means the verification file is served, because that URL is how a
   site gets verified in the first place.
6. **Slot identity is derived, not registered.** `<base>_<w>x<h>` + scope
   suffix; the server enrols a slot on its first serve; every distinct ID is
   a permanent dashboard row with its own floor learning and ad pool, so the
   rules that mint IDs are conservative.
7. **The container is authoritative for ad size.** The inline style on the
   slot `div` (fill the column up to `max-width`, keep aspect ratio, centre)
   is the contract the banner fills into.
8. **No build step.** Plain PHP, plain ES5 block script, `block.json`
   metadata. The folder on disk is the artifact; `build-zip.sh` only gates
   and zips.
9. **One HTML document = one loader pass.** A slot ID renders at most once
   per request (except in admin/AJAX/REST/feeds, where one response can carry
   several renders).
10. **Say what the URL really does.** Live checks (loopback fetch, server
    probe, token check) over inferring from saved settings.

---

## 2. Repository layout

```
integrations/wordpress/
├── README.md                   ← this document
├── promovolve/                 ← THE PLUGIN. This directory is what ships, byte for byte.
│   ├── promovolve.php          ← all PHP: tag, verification, slots, hints, settings, notices (~1 680 lines)
│   ├── uninstall.php           ← runs on Delete; keeps settings unless opted out
│   ├── readme.txt              ← WordPress.org-format readme; Changelog = release notes; Stable tag = version
│   └── blocks/slot/
│       ├── block.json          ← block metadata (apiVersion 3, attributes, supports, editorScript handle)
│       └── editor.js           ← edit() in ES5 via wp.element.createElement; save() returns null
├── tests/
│   ├── topic-test.php          ← topic/place hint rules; stubbed WP surface; no WordPress install needed
│   └── token-test.php          ← token-check state machine, fail-open, cache, bookkeeping
├── build-zip.sh                ← version-agreement gate + php -l + tests + node --check → dist/promovolve-<v>.zip
├── docker-compose.yml          ← throwaway WordPress on :8088, plugin dir bind-mounted
└── dist/                       ← gitignored build output (the blanket **/dist/ rule)
.github/workflows/
├── wp-plugin-build.yml         ← manual; artifact only; contents: read
└── wp-plugin-release.yml       ← tag wp-v<version> or manual; PUBLIC GitHub Release; contents: write
docs/guides/publisher-integration.md   ← publisher guide (WordPress section); copied to platform/help/publisher.md by scripts/sync-help.sh
docs/design/SITE_TOKEN_CHECK.md        ← spec for the token-check endpoint + plugin behaviour
```

There is no Composer, no npm, no autoloader, no classes, no namespaces: the
plugin is procedural PHP in the global namespace with a `promovolve_` prefix
on every function and a `PROMOVOLVE_` prefix on every constant.

---

## 3. Code map

All line numbers refer to `promovolve.php` at 0.5.4; they drift, the names
do not.

### 3.1 Constants

| Constant | Value | Used for |
|---|---|---|
| `PROMOVOLVE_OPTION` | `'promovolve_settings'` | the one settings option |
| `PROMOVOLVE_VERSION` | `'0.5.4'` | cache-buster for `editor.js` (`wp_register_script` version). Must equal the header `Version:` and readme `Stable tag:`. |
| `PROMOVOLVE_PLACE_TAXONOMY_RECOMMENDED` | `'destination'` | the one slug the settings page recommends to a site with no place taxonomy |
| `PROMOVOLVE_PLACE_TAXONOMY_GROUPS` | `array('admin'=>[…],'generic'=>[…],'sub'=>[…],'plugin'=>[…])` | display grouping on the settings page only |
| `PROMOVOLVE_PLACE_TAXONOMIES` | flat list of 52 slugs | **matching** list for the place hint. `tests/topic-test.php` asserts GROUPS ⟺ flat, no slug in two groups, RECOMMENDED ∈ flat. PHP 7.4 cannot spread inside a constant array, hence two constants + a test. |
| `PROMOVOLVE_TOPIC_TAXONOMY_DENY` | `array('post_format')` | taxonomies never read as topic *or* place (shared structural filter) |
| `PROMOVOLVE_WELLKNOWN_TRANSIENT` | `'promovolve_wellknown_status'` | loopback check cache (1 min) |
| `PROMOVOLVE_VERIFIED_TRANSIENT` | `'promovolve_verification_status'` | serve-probe cache (5 min) |
| `PROMOVOLVE_TOKEN_TRANSIENT` | `'promovolve_token_status'` | token-check cache (5 min) |
| `PROMOVOLVE_TOKEN_STATE_OPTION` | `'promovolve_token_state'` | slow-burn bookkeeping — a **separate option** so writing it does not fire the settings purge |
| `PROMOVOLVE_NOTICE_FUSE` | `array('unknown'=>7*DAY_IN_SECONDS,'stale'=>DAY_IN_SECONDS)` | how long a state must stand before its notice shows. Because it reads `DAY_IN_SECONDS` at include time, any test that includes the plugin must define `MINUTE_IN_SECONDS`/`DAY_IN_SECONDS` first. |

### 3.2 Functions

| Function | Purpose | Called from | Notes |
|---|---|---|---|
| `promovolve_settings()` | option + defaults via `array_merge` | everywhere | `get_option` is autoloaded → no extra query. Defaults are the authority for new keys. The `@return` docblock shape is stale (missing `auto_slot_scope`, `destination_taxonomy`, `delete_on_uninstall`). |
| `promovolve_canonical_host()` | `home_url` host, lowercased, one leading `www.` stripped | settings page (placeholder, DNS TXT line) | Mirrors the server's host = site identity model (www/apex merged; any other subdomain = separate site). |
| `promovolve_declared_topic()` | the page's topic names → `data-section` | `script_loader_tag` | singular → taxonomies via `promovolve_topic_taxonomies`; term archives → the queried term; else `''` |
| `promovolve_declared_place()` | the page's place names → `data-place` | `script_loader_tag` | singular only; enumerates `promovolve_readable_taxonomies` **independently** of the topic filter, keeps slugs ∈ filtered `PROMOVOLVE_PLACE_TAXONOMIES`; falls back to `geo_address` meta |
| `promovolve_topic_taxonomies($post_id)` | ordered, filtered list for the topic hint | `promovolve_declared_topic` | `category`, `post_tag` first; rest `sort()`ed; then `promovolve_topic_taxonomies` filter |
| `promovolve_readable_taxonomies($post_id)` | structural test both hints share | both hint paths | `get_object_taxonomies(get_post_type($post_id),'objects')` → keep `public && show_ui`, drop DENY. **Deliberately unfiltered** (a filter here would couple the two hints again). |
| `promovolve_context_taxonomies()` | site-wide place/topic split for the settings report | settings page | `get_taxonomies(['public'=>true],'objects')` across all post types — mirrors, does not reuse, the per-post rule |
| `promovolve_interleave($lists)` | round-robin merge of per-taxonomy term lists | both hints | what keeps eight tags from pushing `destination` past the cap |
| `promovolve_join_topic($names)` | trim, drop empties, de-dup, cap **8**, join `, ` | both hints | server caps at 200 chars anyway; 8 keeps the attribute short |
| `promovolve_slot_html($slot_id,$w,$h,$class='')` | the slot container | shortcode, auto slot | `''` if id empty, w/h < 1, or claim refused |
| `promovolve_slot_claim($slot_id)` | first-come-per-request claim on an ID | `promovolve_slot_html`, block render | `static $claimed`; bypassed when `is_admin() \|\| wp_doing_ajax() \|\| is_feed() \|\| REST_REQUEST` |
| `promovolve_slot_style($w,$h)` | `display:block;width:100%;max-width:{w}px;aspect-ratio:{w}/{h};margin:16px auto;` | slot html, block render | the container-is-authoritative contract |
| `promovolve_sized_slot_id($base,$w,$h)` | `"{$base}_{$w}x{$h}"` | auto slot, block | NOT applied to shortcode IDs (already live inventory rows) |
| `promovolve_slot_scope_suffix($scope)` | `''` / `-<catslug>` or `-cat<id>` / `-post-<ID>` | auto slot, block | singular only; no category → `''` |
| `promovolve_auto_slot_id($s)` | sized id + suffix for the automatic slot | `the_content` filter | |
| `promovolve_render_slot_block($attributes)` | block `render_callback` | core, on front-end render | sanitises `slotId` to `[a-z0-9-]`, validates w/h and scope, claims, wraps with `get_block_wrapper_attributes(['style'=>…])` |
| `promovolve_token_status($s)` | `valid\|stale\|unknown\|unreachable` | `.well-known` handler, settings page | POST token-check; cached 5 min; records state; see §6.3 |
| `promovolve_record_token_state($state)` | maintain `{state, since, dismissed}` | `promovolve_token_status` | no-op on unchanged state; `update_option(…, false)` (no autoload) |
| `promovolve_verification_status($s)` | `verified\|unverified\|unknown` | settings page | POST `/v1/serve/batch` with `imp: []`; cached 5 min; see §7 |
| `promovolve_wellknown_status($configured_token)` | `serving\|foreign\|missing\|unknown` + token + code | settings page (unverified branch) | loopback GET, `redirection=>2`; body grepped for the token line; cached 1 min |
| `promovolve_sanitize_settings($input)` | Settings API sanitizer | `register_setting` | see §6.4 |
| `promovolve_purge_page_caches()` | drop the 3 transients + purge 10 page caches (no object-cache flush since 0.5.4) | `add_option_…`, `update_option_…` | see §5.4 |
| `promovolve_render_settings_page()` | the whole Settings → Promovolve screen | `add_options_page` | ~420 lines of markup; runs the three live checks |

### 3.3 Hooks, in registration order, with the priority rationale

| Hook | Priority | Callback | Why this priority / hook |
|---|---|---|---|
| `wp_enqueue_scripts` | 10 | closure | enqueue `promovolve-ad` (version `null` → no `?ver=`; `in_footer=false` → head) only when site_id, api_base, script_url are all set |
| `script_loader_tag` | 10, 2 args | closure | splice `data-*` onto the real `<script src>` (loader reads `document.currentScript`); `preg_replace_callback('/ src=/', …, $tag, 1)` — first occurrence only, callback not replacement string |
| `init` | **5** | closure | register the optional `destination` taxonomy before the default priority so it exists by the time anything enumerates taxonomies on this request |
| `init` | **1** | closure | the `/.well-known/promovolve.txt` responder. Priority 1 so it answers before anything else on `init` touches the request; `init` itself is late enough that WordPress is fully loaded (options, HTTP API, pluggables) and early enough to precede the query, `template_redirect` and `redirect_canonical`'s 301. |
| `add_shortcode('promovolve_slot')` | — | closure | `shortcode_atts` id/w/h/class → `promovolve_slot_html` |
| `the_content` | 10 | closure | automatic slot: `auto_slot_enabled && is_singular() && in_the_loop() && is_main_query()` |
| `init` | 10 | closure | `wp_register_script('promovolve-slot-block', …, deps, PROMOVOLVE_VERSION, true)`, `wp_add_inline_script(… 'before')` with `window.promovolveBlock = {configured, settingsUrl}`, `register_block_type(dir, ['render_callback' => …])`. Note this runs on the front end too (registration must happen on every request for dynamic render). |
| `admin_init` | 10 | closure | `register_setting('promovolve', PROMOVOLVE_OPTION, ['type'=>'array','sanitize_callback'=>…])` |
| `add_option_promovolve_settings` | 10 | `promovolve_purge_page_caches` | the **first** save creates the row → `add_option_*` fires, not `update_option_*` |
| `update_option_promovolve_settings` | 10 | `promovolve_purge_page_caches` | every later save (WordPress skips the hook entirely when the value is unchanged) |
| `admin_notices` | 10 | closure | slow-burn notice; `manage_options` only |
| `admin_init` | 10 | closure | `?promovolve_dismiss_token_notice=1` handler: capability + `check_admin_referer`, set `dismissed=true`, `wp_safe_redirect(remove_query_arg(…))`, `exit` |
| `admin_menu` | 10 | closure | `add_options_page` under Settings |
| `plugin_action_links_<basename>` | 10 | closure | "Settings" link on the Plugins list |

### 3.4 The block (`blocks/slot/`)

`block.json`: `name promovolve/slot`, `apiVersion 3`, category `widgets`,
icon `megaphone`, attributes `slotId:string='in-content'`, `w:number=300`,
`h:number=250`, `scope:string='site'`; supports `html:false`,
`spacing.margin:true`, `align:false`; `editorScript: "promovolve-slot-block"`
(a **handle**, registered by PHP, because there is no `*.asset.php`).

`editor.js` (IIFE over `window.wp`, bails if `wp.blocks`/`wp.element`/
`wp.blockEditor` are absent): `SIZES` presets, `SCOPES` with display tokens
(`''`, `-<category>`, `-post-<id>`), `sanitizeId` (lowercase, `[a-z0-9-]`),
`sizedId`, `collectSlots` (recursive over innerBlocks), `sizeSelectValue`.
`edit()` computes the effective ID, a `useSelect` duplicate check across
`core/block-editor` blocks (suffix-aware: two blocks collide only when their
sized id + scope token match), a validity flag (non-positive size renders
nothing on the front end, so the canvas must not look confident), a
`useBlockProps` style identical to the PHP container, a placeholder with
state messages, and `InspectorControls` (Slot ID, Size preset, Width/Height
clamped to ≥1, Slot identity, the dashboard-ID sentence, duplicate Notice,
not-configured Notice with a link to settings). `save()` returns `null`.

---

## 4. Lifecycles: what runs when

### 4.1 On every request (plugin include)

Including `promovolve.php` defines constants and functions and registers
hooks. **No database access at include time**; the first `get_option` happens
inside a hook. `promovolve_settings()` is cheap (autoloaded option).

### 4.2 Front-end page render

```
init@1   promovolve .well-known responder → not our path → return
init@5   if destination_taxonomy && !taxonomy_exists('destination') → register_taxonomy
init@10  register block script + inline config + register_block_type
wp_enqueue_scripts
         all three connection fields set? → wp_enqueue_script('promovolve-ad', script_url, [], null, false)
(head)   script_loader_tag('promovolve-ad')
           $section = promovolve_declared_topic()      // may be ''
           $place   = promovolve_declared_place()      // may be ''
           splice ' data-pub=".." data-api=".."[ data-section=".."][ data-place=".."] src=' (first ' src=' only)
(body)   the_content → auto slot appended when enabled && singular && main loop
         [promovolve_slot …] → promovolve_slot_html (ID verbatim)
         block render_callback → promovolve_render_slot_block (sized id + suffix)
         each → promovolve_slot_claim: second render of the same ID in this request → ''
```

Hint computation runs once per page in the filter. `is_singular()`,
`get_queried_object_id()`, `get_the_terms()` are all cached by WordPress at
that point; there is no per-term query beyond what core already did.

### 4.3 A request for `/.well-known/promovolve.txt`

```
init@1
  REQUEST_URI path (wp_parse_url(wp_unslash(...), PHP_URL_PATH)) === '/.well-known/promovolve.txt' ?
  token stored? no → return (WordPress handles the URL; with plain permalinks core 301s to the trailing-slash URL)
  promovolve_token_status($s):
     site_id/api_base/token all set? no → 'unreachable'
     transient hit → return it
     POST {api_base}/v1/sites/{site_id}/token-check {"token": …} timeout 5
     200 + body.state ∈ {valid,stale,unknown} → that; else 'unreachable'
     record state (option), cache 5 min
  state ∈ {stale, unknown} → status_header(404); nocache_headers(); Content-Type text/plain; exit
  else → nocache_headers(); Content-Type text/plain; echo 'promovolve-site-verification=<token>'; exit
```

Because this runs on a **front-end** request, a cold cache can add up to
5 s (the HTTP timeout) to the verification URL once per 5 minutes. That is
accepted: the URL is fetched by the dashboard and by admins, not by readers.

### 4.4 Admin: Settings → Promovolve

Render order matters because each check is a live request when its cache is
cold:

1. `promovolve_verification_status($s)` — serve probe (5-min cache).
2. Branch **verified**: green box; token field; `promovolve_token_status($s)`
   to print *empty / stale / valid* guidance (5-min cache).
   Branch **not verified**: token field; `promovolve_token_status($s)`
   (stale / unknown messages, else the 403 "not recognised yet" text);
   `promovolve_wellknown_status($token)` loopback (1-min cache); DNS TXT line.
3. Slots section (theme-aware copy via `wp_is_block_theme()` guarded by
   `function_exists`), Page context, uninstall checkbox, submit, cache note,
   Active tag preview, "Context this site sends" report
   (`promovolve_context_taxonomies()`, the folded slug table, the filter
   snippet).

### 4.5 Admin: saving settings

```
POST options.php (Settings API, nonce from settings_fields('promovolve'))
  promovolve_sanitize_settings($input) → $clean (starts from current settings + defaults)
  update_option('promovolve_settings', $clean)
     value unchanged → WordPress returns false and fires NOTHING (no purge) — fine, nothing changed
     first ever save → add_option_promovolve_settings → promovolve_purge_page_caches
     otherwise      → update_option_promovolve_settings → promovolve_purge_page_caches
        delete 3 transients; purge 10 page caches (guarded)
```

### 4.6 Admin notices and dismissal

On every admin page (`manage_options`): read `promovolve_token_state`; bail
if absent, dismissed, state has no fuse (`valid`, `unreachable`), or
`time() - since < fuse`. Otherwise print the warning with *Open settings* and
*Dismiss* (nonced URL). The dismiss handler sets `dismissed=true` and
redirects. The next **state change** resets `dismissed` to `false`
(`promovolve_record_token_state`).

### 4.7 Block editor

`editorScript` handle loads with deps `wp-blocks wp-element wp-block-editor
wp-components wp-data wp-i18n`, version `PROMOVOLVE_VERSION`, in footer;
`window.promovolveBlock` is inlined **before** it. The block's server-side
`render_callback` runs on the front end; in the editor the canvas is
`edit()` (`example` in `block.json` feeds the inserter preview). REST
responses that embed rendered post content (`content.rendered` for a list)
call it too, which is why `promovolve_slot_claim` returns `true` under
`REST_REQUEST`.

### 4.8 Deactivate / delete

Deactivate: nothing runs (no deactivation hook), option and terms stay.
Delete: `uninstall.php` — `WP_UNINSTALL_PLUGIN` guard; read
`promovolve_settings` directly (plugin functions are not loaded); delete it
**only if** `delete_on_uninstall`; always delete `promovolve_token_state` and
the three transients. Terms of a `destination` taxonomy are never touched.

---

## 5. State and data

### 5.1 `promovolve_settings` (option, autoloaded)

| Key | Type | Default | Sanitised to | Read by |
|---|---|---|---|---|
| `site_id` | string | `''` | lowercase `[a-z0-9-]` | tag, probes, block config |
| `api_base` | string | `''` | `esc_url_raw` → no trailing `/` → no trailing `/v1` → no trailing `/` | tag, probes |
| `script_url` | string | `''` | `esc_url_raw` | tag, block config |
| `verification_token` | string | `''` | strip `^promovolve-site-verification=` then `[A-Za-z0-9-]` | `.well-known`, token check, settings page |
| `auto_slot_enabled` | bool | `false` | `!empty` | `the_content` |
| `auto_slot_id` | string | `'article-footer'` | `sanitize_text_field` | auto slot |
| `auto_slot_scope` | `site\|category\|post` | `'site'` | whitelist | auto slot |
| `auto_slot_w`, `auto_slot_h` | int | `728`, `90` | `max(0,(int))` | auto slot |
| `destination_taxonomy` | bool | `false` | `!empty` | `init@5` |
| `delete_on_uninstall` | bool | `false` | `!empty` | `uninstall.php` |

Unknown keys in the stored array survive `array_merge` (defaults first, saved
second), so a downgrade does not lose newer keys and an upgrade never needs a
migration for *added* keys. There is no version stamp in the option and no
migration framework; if a key ever needs to be **renamed**, add a one-shot
rewrite in `promovolve_settings()`.

### 5.2 `promovolve_token_state` (option, **not** autoloaded)

`{ state: valid|stale|unknown|unreachable, since: unix seconds, dismissed: bool }`.
Written only by `promovolve_record_token_state` when the state **changes**;
`since` therefore means "first seen in the current state". Read by the
notice and the dismiss handler. Deleted on uninstall.

### 5.3 Transients

| Transient | TTL | Value | Cleared by |
|---|---|---|---|
| `promovolve_token_status` | 5 min | state string | settings save, uninstall |
| `promovolve_verification_status` | 5 min | `verified\|unverified\|unknown` | settings save, uninstall |
| `promovolve_wellknown_status` | 1 min | `{state, token, code}` | settings save, uninstall |

Under a persistent object cache transients live in the cache, not
`wp_options`; under none they are option rows with `_transient_timeout_*`
siblings. The code never assumes either.

### 5.4 Cache purge list (`promovolve_purge_page_caches`)

| Cache | Mechanism | Guard |
|---|---|---|
| LiteSpeed Cache | `do_action('litespeed_purge_all')` | none needed (no listener → no-op) |
| WP Super Cache | `wp_cache_clear_cache()` | `function_exists` |
| W3 Total Cache | `w3tc_flush_all()` | `function_exists` |
| WP Rocket | `rocket_clean_domain()` | `function_exists` |
| SiteGround Optimizer | `sg_cachepress_purge_cache()` | `function_exists` |
| WP Fastest Cache | `wpfc_clear_all_cache()` | `function_exists` |
| Cache Enabler | `Cache_Enabler::clear_complete_cache()` | `class_exists && method_exists` |
| Breeze | `do_action('breeze_clear_all_cache')` | — |
| Hummingbird | `do_action('wphb_clear_page_cache')` | — |
| WP-Optimize | `wpo_cache_flush()` | `function_exists` |

External caches/CDNs are the publisher's job; the settings page says so.

### 5.5 Token-state machine

```
                     server 200 {"state":"valid"}
   ┌──────────────────────────────────────────────────┐
   │                                                  ▼
 (any) ── 200 stale ──▶ STALE ─(24h)─▶ notice "paste the current token"   file: 404
 (any) ── 200 unknown ▶ UNKNOWN (7d)─▶ notice "check Site ID / add site / delete with box ticked"   file: 404
 (any) ── else ───────▶ UNREACHABLE (resets `since`; no notice)           file: SERVED (fail open)
 (any) ── 200 valid ──▶ VALID (no notice)                                 file: SERVED
 no site_id/api_base/token ──▶ UNREACHABLE without a request
```

Transitions are evaluated at most once per 5 minutes (transient) and
immediately after a settings save. `dismissed` flips to `false` on every
transition. **No transition deletes anything.**

---

## 6. Specifications

### 6.1 Slot identity

```
sized     := base "_" w "x" h                  base ∈ [a-z0-9-]+ (block: sanitised; auto: sanitize_text_field — NOT restricted)
suffix    := ""                                 scope=site, or any non-singular view, or scope=category with no category
           | "-" catslug                        scope=category, catslug matches ^[a-z0-9-]+$
           | "-cat" term_id                     scope=category, slug has other chars (percent-encoded non-Latin)
           | "-post-" post_id                   scope=post
block/auto id := sized suffix
shortcode id  := id attribute, verbatim
```

Examples: `article-footer_728x90`, `article-footer_728x90-travel`,
`in-content_300x250-cat17`, `in-content_300x250-post-4821`, shortcode
`sidebar-top`.

Rules: the automatic slot's base is `sanitize_text_field`ed, not restricted
to `[a-z0-9-]` — a publisher can type spaces or uppercase; the server
accepts any string as a slot ID and the dashboard shows it verbatim.
`get_the_category()` returns the post's `category` terms only (not custom
taxonomies); the plugin takes element `[0]` as WordPress returns it (do not
document an ordering you have not verified). The size suffix applies to the
block and auto slot but **never** to shortcode IDs, because shortcode IDs
written by hand were already live inventory rows when the rule was
introduced (0.1.2 / 0.2.0).

### 6.2 Context hints (topic, place)

**Inputs** (singular view): `T = promovolve_readable_taxonomies(post)` =
post type's taxonomies with `public && show_ui`, minus
`PROMOVOLVE_TOPIC_TAXONOMY_DENY`.

**Topic** = `join(interleave([names(t) for t in filter_topic(order(T))]))` where
`order` puts `category`, `post_tag` first and sorts the rest by name;
`filter_topic` = `apply_filters('promovolve_topic_taxonomies', …, $post_id)`.
Term archives → `[queried term name]`. Otherwise `''`.

**Place** = `join(interleave([names(t) for t in T if t ∈ filter_place(PLACES)]))`
or, if that is empty, `[trim(post_meta geo_address)]` if non-empty, else `''`;
`filter_place` = `apply_filters('promovolve_place_taxonomies', …, $post_id)`.
Non-singular → `''`.

`interleave`: round-robin across lists (i = 0..max len; for each list take
element i if present). `join`: trim, drop empties, `array_unique`, first **8**,
implode `', '`. Place taxonomies are intentionally also in the topic list.

**Server side** (`IABTaxonomy.sanitizeHint`): collapse whitespace, strip
control chars, take first **200** chars; then framed in the prompt as
self-reported / not verified / interested; the model is told to ignore it
when the content disagrees. The hints ride in the ad tag's
`POST /v1/classify-page` body as `section` and `place` (both `Option[String]`
server-side, so an older tag omitting them still parses).

**Built-in `destination` taxonomy**: registered on `init@5` only when
`destination_taxonomy` is on and `taxonomy_exists('destination')` is false;
`object_type ['post']`, non-hierarchical, `public`, `show_ui`,
`show_in_rest` (required for the block-editor sidebar box),
`show_admin_column`, rewrite slug `destination`, labels + description
translatable. Unregistering (unticking) hides the UI; WordPress keeps terms.

**Vocabulary** (`PROMOVOLVE_PLACE_TAXONOMIES`, 52 slugs) — see the constant;
the settings page renders it grouped from `_GROUPS`. Inclusion criterion:
terms are, in practice, somewhere an advertiser can buy (country /
subdivision / city, or something smaller that resolves up); exclusion: slugs
whose terms are usually not places (`venue`, `market`) or describe the
publisher's own address (store locators, Yoast/Rank Math Local).

### 6.3 Verification file and token check

Covered in §4.3 and §5.5. Spec of record: `docs/design/SITE_TOKEN_CHECK.md`.
Invariants worth restating because they are easy to break:

- the 404 is a **real** `status_header(404)` + `exit`, not a fall-through;
- `unreachable` **serves** the file;
- the stored token is **never** modified by the check;
- the state option is separate from the settings option (no purge on
  bookkeeping);
- the token goes in the POST **body**.

### 6.4 Settings sanitisation

`promovolve_sanitize_settings($input)` starts from `promovolve_settings()`
(so unknown/absent keys keep their stored value), then per key as in §5.1.
Checkboxes (`auto_slot_enabled`, `delete_on_uninstall`, `destination_taxonomy`)
are assigned from `!empty($input[...])` unconditionally — an unchecked box is
absent from POST, so "fall through to stored" would make them impossible to
untick. `api_base` is normalised twice with `untrailingslashit` around the
`/v1` strip so `https://x/v1/` → `https://x`.

---

## 7. Ad-server and dashboard contracts

### 7.1 `POST {api_base}/v1/sites/{site_id}/token-check`

Request: `Content-Type: application/json`, body `{"token":"<stored token>"}`,
timeout 5 s, `site_id` `rawurlencode`d (it is already `[a-z0-9-]`).

| Response | Plugin state |
|---|---|
| `200 {"state":"valid"}` | `valid` |
| `200 {"state":"stale"}` | `stale` (site exists, different token — removed and re-added on Promovolve) |
| `200 {"state":"unknown"}` | `unknown` (no such site: never created, still in the approval queue, removed, or a typo) |
| `429` (per-IP `RequestRateGate`, 1/s burst 10 per api pod) | `unreachable` |
| `503` (server-side ask failure) | `unreachable` |
| `404` (ad server older than 2026-08-22, `dbf744b`) | `unreachable` |
| network error / non-JSON / unexpected state | `unreachable` |

Always 200 for known and unknown sites alike — there is no existence oracle
for tokens. Server implementation: `SiteEntity.CheckVerificationToken`
(read-only; does not mint). The plugin half is pinned by `tests/token-test.php`.

### 7.2 `POST {api_base}/v1/serve/batch` (verification probe)

Request body `{"pub": site_id, "url": home_url('/'), "imp": []}`, timeout 5 s.
Server path (`ServeRoutes.scala` → `AdServer.BatchSelect`):

```
siteSuspended?            → BatchSiteSuspended     → HTTP 204
!hostMatches(url, verifiedHost)?  → BatchHostNotVerified → HTTP 403
  (hostMatches is FALSE when verifiedHost is None — e.g. right after an api restart before DData publish)
recordRequestArrival(state, 0)                     (counted as one arrival; no lifecycle beyond that)
slots.isEmpty             → BatchSelected(Vector.empty) → HTTP 200 {"seatbid":[] …}
```

No auction, no slot enrolment, no budget reservation with an empty `imp`.
Plugin mapping (0.5.4): 200 → `verified`, 403 → `unverified`, 204 → `unknown`
(suspension is decided *before* the host gate, so it says nothing about
verification; 0.5.3 and earlier read it as verified), else `unknown`. Pinned
by the "verification probe" cases in `tests/token-test.php`. The ad tag's own batch requests are a
different matter (real `imp`), documented in `publisher-integration.md`.

### 7.3 Loopback `GET home_url('/.well-known/promovolve.txt')`

`redirection => 2`, timeout 5. `serving` iff 200 and the body matches
`/promovolve-site-verification=([A-Za-z0-9-]+)/` with the stored token;
`foreign` if it matches a different token; `missing` otherwise (including an
HTML 200); `unknown` on `WP_Error` (loopback blocked — common).

### 7.4 Dashboard side

- **Verify** (dashboard → Sites): fetches `https://<host>/.well-known/promovolve.txt`,
  then falls back to DNS TXT `_promovolve.<host>` = `promovolve-site-verification=<token>`.
  Verification is one-time and persisted server-side.
- **Site details → ownership re-check** (`GET /publisher/sites/{id}/verification-check`,
  `platform/internal/handler/pages.go`): probes the file, then DNS; states
  `present | foreign | missing | unreachable` (+`method`). **Advisory only** —
  never a serving gate. Taking the proof down after verification is
  legitimate; the plugin keeps serving it mainly so this check stays green.
- **Verification token** disclosure on the site's details (also for verified
  sites since 2026-08-22) — the place a publisher re-copies a lost token.
- **Integration health** panel is fed by the ad tag's mount heartbeat, not by
  the plugin.

### 7.5 What the ad tag does with the plugin's output

`bootstrap.ts` captures `document.currentScript` at install, reads
`dataset.pub/api/section/place` in `autoDisplay` (DOMContentLoaded or
microtask), collects `[data-promovolve-slot]` elements **first match per ID
wins** (`if (slots.has(id)) return;`), skips elements without positive
`data-w`/`data-h`, and POSTs one `/v1/serve/batch`. On a cold/stale page it
extracts page text and POSTs `/v1/classify-page` with `section`/`place`
when set. Without `data-api` it would fall back to the page host on port
8080 — a dev convenience and the reason the plugin refuses to print the tag
without an API base. The loader alias `promovolve-ad.js` is published to R2
with `max-age=300` by `deploy.yml`'s `publish-bootstrap` job, which is why
the plugin enqueues it with version `null` (no `?ver=`).

---

## 8. WordPress behaviours this code depends on

Each of these is load-bearing; several were learned the hard way.

| Behaviour | Where it matters |
|---|---|
| `wp_enqueue_script(..., $ver = null)` prints **no** `?ver=`; `false` would print the WP version. | tag enqueue (stable alias must stay byte-addressable) |
| `script_loader_tag` receives the full `<script …>` string; attributes must be spliced into it because the loader reads `document.currentScript` synchronously. `preg_replace`'s replacement string interprets `$1`/`\1`; a URL can contain `$`/`\` (esc_attr does not strip them) → use `preg_replace_callback`; limit 1 because another filter may add a second ` src=`. | `script_loader_tag` |
| `init` fires before `template_redirect`/`redirect_canonical`; `$_SERVER['REQUEST_URI']` is the raw path+query — parse it, `wp_unslash` it, compare the **path** only. With plain permalinks an unclaimed `/.well-known/x.txt` gets a `301` to `…x.txt/` from core (verified on 6.9.4), so an explicit `404` is needed for "declining to answer". | `.well-known` responder |
| `status_header()` + `nocache_headers()` + `header()` + `exit` is the minimal way to answer a raw URL without a template. | `.well-known` responder |
| `add_option_{$option}` fires on first creation; `update_option_{$option}` on later saves; `update_option` with an unchanged value returns `false` and fires **neither**. | purge hooks |
| Settings API: `register_setting` sanitizer runs on `options.php` POST; `settings_fields()` prints nonce + `option_page`; unchecked checkboxes are absent from POST. | settings save |
| Transients: `get_transient` returns `false` on miss — the code checks `is_string && !== ''` / `is_array` to distinguish. Under an object cache they are not in `wp_options`. | all three caches |
| `static $var` inside a function persists for the PHP request only — a correct per-document claim map, and wrong for responses carrying several documents (REST lists, feeds, AJAX), hence the bypass. | `promovolve_slot_claim` |
| `the_content` runs for excerpts, REST `content.rendered`, and archive loops; `is_singular() && in_the_loop() && is_main_query()` is the standard "main article body" test. | auto slot |
| `get_the_category()` returns `category` terms only; non-Latin slugs are stored percent-encoded (`sanitize_title` → `utf8_uri_encode`). | scope suffix |
| `get_object_taxonomies($type,'objects')` returns `WP_Taxonomy` objects with `public`/`show_ui`; `get_the_terms` returns `false` for none and `WP_Error` for an invalid taxonomy — `is_array` covers both. | hints |
| `register_block_type($dir, $args)` reads `block.json`; `editorScript` may be a registered **handle** when no `*.asset.php` exists; `render_callback` makes it dynamic (`save()` must return `null`). `get_block_wrapper_attributes(['style'=>…])` merges the block's generated classes/styles (margin support) after ours, so publisher margins win. | block |
| `wp_add_inline_script($handle, $js, 'before')` prints before the handle's script — config object must exist before `editor.js` runs. | block config |
| `show_in_rest => true` on a taxonomy is what makes the block editor show its sidebar panel; `unregister_taxonomy`/not registering keeps term rows. | destination taxonomy |
| `wp_is_block_theme()` exists since 5.9 — guarded with `function_exists` because hosts run older cores than the header claims. | settings copy |
| `wp_remote_get` to the site's own URL (loopback) is blocked on many hosts → must be reported as *unknown*, not *missing*. | wellknown check |
| `is_admin() \|\| wp_doing_ajax() \|\| is_feed() \|\| REST_REQUEST` is the practical "not a single front-end document" test. | slot claim bypass |
| Plugins → Add New → Upload → *Replace current with uploaded* (WP 5.5+) keeps options; Delete runs `uninstall.php`; Deactivate runs nothing here. | upgrade guidance |
| Hosting page caches (LiteSpeed on Hostinger: **7 days**) hold the old tag/slot markup; `do_action('litespeed_purge_all')` is LiteSpeed's public purge hook. LiteSpeed also caches a 404 page (`x-litespeed-cache: hit`) — probe with `?nocache=1`. | purge; troubleshooting |

---

## 9. Security model

- **Capabilities**: `manage_options` for the settings page, notices and the
  dismiss action. Nothing else is admin-reachable.
- **CSRF**: settings via Settings API nonce; dismiss via `wp_nonce_url` +
  `check_admin_referer('promovolve_dismiss_token_notice')`.
- **Input**: every stored value is whitelisted/escaped on save (§5.1). Block
  `slotId` sanitised in JS **and** PHP. Shortcode attributes pass through
  `esc_attr`/`(int)`.
- **Output**: `esc_attr`/`esc_html`/`esc_url` everywhere; the two
  `phpcs:ignore WordPress.Security.EscapeOutput` sites are the token echo
  (charset-restricted, `text/plain`) and a `$link` built from `esc_url` +
  `esc_html`; `get_block_wrapper_attributes` is core-escaped.
- **SSRF surface**: outbound requests go to the admin-configured `api_base`
  (an admin can already run arbitrary code on a WordPress site, so this is
  not an escalation) and to `home_url()`.
- **Secrets**: the token travels in a POST body to `api_base`; use `https`.
  It is also printed publicly at `/.well-known/` by design — it is an
  ownership proof, not a credential to the dashboard. The server enforces
  rate limiting and no existence oracle on the check endpoint.
- **Privacy**: nothing reader-specific is computed or printed (§1 principle
  1). No cookies. The ad tag's own storage is IndexedDB dog-ear bookmarks
  (browser side).
- **Filesystem**: never written; `.well-known` is answered from the request
  path.

---

## 10. Extending the plugin — recipes

### Add a setting
1. Default in `promovolve_settings()` (and the `@return` docblock).
2. Sanitise in `promovolve_sanitize_settings()` — checkbox → `!empty`
   unconditional; text → `isset` guard + sanitiser.
3. Field in `promovolve_render_settings_page()`; name
   `promovolve_settings[<key>]`; `checked()`/`selected()`/`esc_attr()`.
4. If it changes front-end markup, nothing else: the purge already fires on
   save. If it must **not** purge (bookkeeping), it belongs in a separate
   option like `promovolve_token_state`.
5. Tests: if the setting affects hints/token logic, extend the relevant test.
6. `readme.txt` changelog line; `publisher-integration.md` if publishers
   need to know; this README §5.1.

### Add a place slug
1. Append to **both** `PROMOVOLVE_PLACE_TAXONOMIES` and the right group in
   `PROMOVOLVE_PLACE_TAXONOMY_GROUPS` (the test
   `place-taxonomy-groups-cover-the-list` fails otherwise).
2. Ask the inclusion question (§6.2): are its terms somewhere an advertiser
   can buy, and the article's subject rather than the publisher's address?
3. Changelog line. No server change needed — names are resolved there.

### Add a cache plugin to the purge
Add a guarded call to `promovolve_purge_page_caches()`; prefer the plugin's
documented public function or action; `function_exists`/`class_exists`
guard; comment with the plugin name. Note it in `readme.txt`.

### Add a notice state / change a fuse
`PROMOVOLVE_NOTICE_FUSE` + the `admin_notices` closure text. Keep the
fuse-not-on-first-sight rule and the "nothing deletes anything" rule.

### Add another server probe
Follow `promovolve_token_status`: transient + TTL, `wp_remote_*` with
`timeout => 5`, map every non-expected answer to a fail-safe state, clear the
transient in `promovolve_purge_page_caches`, delete it in `uninstall.php`,
and pin the mapping in a test. Decide explicitly whether it may run on the
front end (today only the token check does).

### Add a block attribute
`block.json` attributes → `editor.js` control + `displayId`/validity logic →
`promovolve_render_slot_block` reads it with a default and validates it →
if it changes the ID, update §6.1 and the duplicate check's token logic.

### Add a test case
Both tests are self-contained PHP scripts: define `ABSPATH`,
`MINUTE_IN_SECONDS`, `DAY_IN_SECONDS`; stub exactly the WordPress functions
the code under test calls (they live at the top of each file — add a stub if
you call something new, or the include fatals); `require` the plugin; call
`t($label, $expected, $actual)`. `topic-test.php` uses `fixture($taxonomies,
$terms, $flags)` + `$GLOBALS['pv']` for `is_singular` etc.;
`token-test.php` uses `$GLOBALS['tk']` with `respond($code, $body)`,
`reset_state()`, and inspects `last_post`. Run with `php tests/<file>.php`;
`build-zip.sh` runs both.

### Ship a translation
Add `languages/promovolve-<locale>.po/.mo` **and** call
`load_plugin_textdomain('promovolve', false, dirname(plugin_basename(__FILE__)).'/languages')`
on `init` — today neither exists (§14). Strings are already wrapped.

---

## 11. Testing and verification

### Unit tests (no WordPress)

```
php tests/topic-test.php    # 23 cases: custom taxonomies read; tag-heavy post still ships destination;
                            # cap; post_format/non-public excluded; order; filters; archives; front page;
                            # place taxonomy; geo_address fallback and precedence; topic/place independence;
                            # groups ⟺ flat list; no slug in two groups; recommended slug is read
php tests/token-test.php    # 23 cases: no token → unreachable without a request; URL shape; token in body
                            # not URL; cache honoured; save drops cache; since/dismissal bookkeeping;
                            # fuses 7d/24h; valid/unreachable have no fuse; serve-probe mapping
                            # (200 verified / 403 unverified / 204+5xx+429+error unknown; empty imp)
```

No PHP locally: `docker run --rm -v "$PWD":/w -w /w php:8.2-cli php tests/topic-test.php`.

### Build gate
`./build-zip.sh` runs `php -l` on all PHP, both tests, `node --check` on JS,
parses `block.json`, and refuses on version skew (§12). Missing `php`/`node`
fails unless `PROMOVOLVE_ALLOW_UNVERIFIED=1`.

### Docker WordPress loop

```
cd integrations/wordpress
docker compose up -d                 # http://localhost:8088 — run the installer once
docker compose down -v               # wipe
```

Plugin dir is bind-mounted (edits live on refresh). Rules: **never use
WordPress's Delete on this plugin in the Docker site** — it `rm -rf`s the
mounted source; after editing `editor.js` hard-reload the editor (cache-busted
by `PROMOVOLVE_VERSION`, not mtime); `WORDPRESS_DEBUG=1` turns white screens
into notices.

Useful one-liners (container name from `docker ps`, e.g. `wordpress-wordpress-1`):

```bash
# read plugin state
docker exec <wp> php -r 'require "/var/www/html/wp-load.php"; var_export(get_option("promovolve_settings")); var_export(get_option("promovolve_token_state")); var_export(get_transient("promovolve_token_status"));'
# run uninstall.php without deleting the mounted dir
docker exec <wp> php -r 'define("WP_UNINSTALL_PLUGIN",true); require "/var/www/html/wp-load.php"; include "/var/www/html/wp-content/plugins/promovolve/uninstall.php";'
# probe the verification URL without following redirects (curl may be policy-blocked on dev machines; python works)
python3 -c 'import urllib.request as u; r=u.build_opener(type("N",(u.HTTPRedirectHandler,),{"redirect_request":lambda *a,**k:None})).open("http://localhost:8088/.well-known/promovolve.txt"); print(r.status, r.read())'
```

### Stubbing the ad server inside Docker WP
Drop an mu-plugin (`wp-content/mu-plugins/promovolve-stub.php`) that answers
the two server calls, e.g.:

```php
<?php
add_filter( 'pre_http_request', function ( $pre, $args, $url ) {
	if ( false !== strpos( $url, '/v1/serve/batch' ) ) {
		return array( 'response' => array( 'code' => 200, 'message' => 'OK' ), 'headers' => array(), 'body' => '{"seatbid":[]}' );
	}
	if ( false !== strpos( $url, '/token-check' ) ) {
		return array( 'response' => array( 'code' => 200, 'message' => 'OK' ), 'headers' => array(), 'body' => '{"state":"valid"}' );
	}
	return $pre;
}, 10, 3 );
```

Change `"valid"` to `"stale"`/`"unknown"` to exercise the 404 path and the
settings messages; save settings to drop the caches between changes.

### Browser checks (Playwright)
Nothing automated renders the settings page; the pattern that works: log in
(`wp-login.php` form post), open `options-general.php?page=promovolve`, grep
the HTML for `PHP Warning`/`Notice`/`Deprecated`, assert the expected
boxes. For Gutenberg use `waitUntil: 'domcontentloaded'` + `waitForSelector`
— `networkidle` never settles in the editor.

### Release checklist (manual, in Docker WP unless stated)
1. Settings page renders on a fresh install with no notices; all three
   verification branches (verified via stub; unverified + stale; unverified +
   unknown) show the right text.
2. Tag in `<head>` with `data-pub`/`data-api`; `data-section`/`data-place`
   on a post with terms; absent on the front page.
3. `/.well-known/promovolve.txt`: 200 + exact line with a valid/unreachable
   token; real 404 with stale/unknown; WordPress's 301 when the plugin is off.
4. Block inserts, previews, warns on duplicate, renders the sized ID; shortcode
   renders verbatim; auto slot appends once with the right suffix per scope.
5. Save settings → caches dropped (transients gone), page cache purge action
   fired.
6. `uninstall.php` keeps/removes the option per the checkbox; state option
   and transients gone.
7. `./build-zip.sh` green; install the produced zip into a second WP via
   Upload Plugin → "Replace current with uploaded".
8. Against the **production** api (bogus tokens only, never a real one):
   token-check returns `unknown` → plugin 404s.

---

## 12. Build, versioning, CI, release

**Three version strings must agree**: `promovolve.php` header `Version:`,
`const PROMOVOLVE_VERSION`, `readme.txt` `Stable tag:`. `build-zip.sh`
refuses otherwise. The constant is the nastiest to forget: it versions
`editor.js`, so a stale constant means editors keep serving the old cached
block script and a shipped block fix silently does not apply.

**`build-zip.sh`** (from `integrations/wordpress/`): gates (above), then
`zip -r -q -X dist/promovolve-<v>.zip promovolve -x '*.DS_Store' …` — zips
the **directory** so the archive has a single top-level `promovolve/`
folder (what the uploader requires); `-X` drops macOS extended attributes
(otherwise `__MACOSX/` appears); then verifies no `__MACOSX` and that
`promovolve/promovolve.php` is present.

**`wp-plugin-build.yml`** — `workflow_dispatch` only, `permissions:
contents: read` (cannot create a release even by mistake). Runs
`build-zip.sh`, then **unzips** the result into `staging/` and uploads the
**directory** as artifact `promovolve-plugin-<version>`. Uploading the zip
itself produced zip-in-zip ("No valid plugins were found"). The artifact
download installs as-is.

**`wp-plugin-release.yml`** — on push of tag `wp-v*` or dispatch;
`permissions: contents: write`; **publishes publicly** (the repo is public).
Guards `GITHUB_REF_NAME == wp-v<plugin version>`; extracts the version's
block from `readme.txt` with an awk that takes the **first** `= x.y.z =`
match and stops at the next `= ` or `== ` heading — so *Upgrade Notice* must
stay **after** *Changelog*; appends an install line; `gh release create`
(or `view` + `upload --clobber` for idempotency). Release assets are the
only distribution channel besides artifacts; `dist/` is gitignored.

**Releasing 0.x.y**: bump the three strings → `readme.txt` `= x.y =` block
(+ Upgrade Notice if installing needs words) → `./build-zip.sh` → Docker WP
checklist (§11) → commit → either dispatch the build workflow (artifact,
private-ish) or `git tag wp-vx.y && git push --tags` (public). Note the
record: `wp-v0.2.2` is the only public Release; 0.3.0–0.5.4 shipped as
artifacts; a `wp-v0.4.0` release was published and then deleted.

The cluster deploy (`deploy.yml`) never packages the plugin, and a plugin
release never rolls the cluster. The **ad tag** (`platform/banner-bootstrap`)
is a separate artifact published to R2 by `deploy.yml`; a plugin change that
needs a new tag capability (e.g. a new `data-*` attribute) must land the tag
first — the plugin can print an attribute the tag ignores, never the reverse.

---

## 13. Compatibility policy

- Header: WordPress ≥ 6.0, PHP ≥ 7.4; `readme.txt` `Tested up to: 7.0`.
- Verified environments: Docker `wordpress:6-php8.3-apache` (6.9.4 at last
  check, plain permalinks) and a Hostinger shared host (WordPress 7.0.x,
  LiteSpeed; PHP version not recorded).
- PHP: a scan finds no PHP 8-only syntax (`fn`, `match`, `?->`,
  `str_contains`, enums, readonly); nothing actually runs the suite under
  7.4 — `php -l` uses whatever the machine/CI has. If 7.4 support matters,
  run the tests in `php:7.4-cli`.
- Block: `block.json` `apiVersion: 3` targets the iframed editor (WP 6.3+).
  Behaviour on 6.0–6.2 has **not** been checked.
- Themes: block and classic both supported; the settings copy adapts via
  `wp_is_block_theme()`.
- Multisite: not tested. Options are per-site; nothing network-wide is
  touched (the object-cache flush that could have crossed sites was removed
  in 0.5.4).
- Ad server: the token check needs api ≥ 2026-08-22; older servers → the
  plugin behaves like 0.5.0 (file always served).

---

## 14. Known gaps and open issues

As of 0.5.4 / 2026-08-23.

**Fixed in 0.5.4** (kept here one release for anyone diffing): 204 now maps
to `unknown`, not `verified`; the object-cache flush is gone from the purge;
`readme.txt`'s privacy paragraph no longer claims GPC visitors get no ads
(the server serves under `Sec-GPC: 1` since 2026-08-12 — `ServeRoutes.scala`,
`GPC.md`) and states the dog-ear TTL correctly; the 403 comment names all
three causes; the stale pre-0.5.0/0.5.2 comments and the `@return` shape are
updated; the auto-slot checkbox says "single posts, pages and other single
views".

Still open:

1. **`destination` taxonomy is `post`-only**; pages/CPTs need their own
   registration or a `register_taxonomy_for_object_type` call. Design
   choice so far, not an oversight — revisit if a CPT-based site asks.
2. **i18n inert**: no `languages/`, no `load_plugin_textdomain` (§10 recipe).
3. **No option versioning/migration** hook (fine while keys are only added).
4. **Front-end HTTP call** on cold `.well-known` hits (5 s worst case) —
   accepted and documented; a WP-Cron refresh would keep the front-end path
   read-only.
5. **Auto-slot base not charset-restricted** (unlike block IDs). Harmless
   server-side; restricting it now would rename live publishers' slots, so
   leave it unless a sanitiser-at-display is added.
6. **403 false negative after an api restart** (verified host unknown to the
   entity) is documented, cached ≤ 5 min; a retry-on-403 with a shorter TTL
   would soften it.
7. **`apiVersion: 3` on WP 6.0–6.2** unverified (§13).

## 15. Lessons already paid for

Dated, plugin-relevant only; the repo-wide memory holds the rest.

- **2026-08-01** — Hostinger/LiteSpeed cached pages for **7 days**; a scope
  change "didn't apply" until a manual purge → settings save purges known
  caches (0.1.1 widened the list; `add_option_*` added for the first save).
- **2026-08-05** — A bare slot `div` stretched to the theme column (300×250 →
  ~700 px) → inline `max-width`/`aspect-ratio` container contract (0.1.3).
- **0.2.0** — Archives rendering full content repeated in-content slot IDs;
  the loader fills only the first → one-render-per-ID claim with
  admin/AJAX/REST/feed bypass.
- **0.2.1** — A 200 that is really an HTML catch-all page is not "file
  served" → the loopback check greps the body for the token line.
- **0.3.0** — Eight tags pushed `destination` past the cap → round-robin
  interleave; cap 5 → 8.
- **0.5.0** — Deleting the plugin destroyed the last copy of the token
  (dashboard hid it once verified) → uninstall keeps settings by default;
  dashboard regained a token disclosure. Also: `preg_replace` with a
  replacement string would eat `$1`/`\` in publisher URLs → callback; and
  `str_replace` on ` src=` hit every occurrence → limit 1. Also: a
  `promovolve_topic_taxonomies` filter silently killed place reading →
  independent enumeration, one filter each.
- **2026-08-22 (0.5.1)** — A site removed and re-added on Promovolve gets a
  new token and the plugin served the old one forever → token check + real
  404; `unknown` must not delete (it also means "awaiting approval");
  notices not on first sight. The token-state option was moved **out of**
  `promovolve_settings` because writing it there purged the publisher's page
  cache every five minutes.
- **2026-08-22 (0.5.2)** — Hiding the token field on verified sites left a
  publisher restoring a lost token with nowhere to paste it → field stays,
  marked optional.
- **2026-08-22 (CI)** — Uploading the built zip as an Actions artifact gave
  zip-in-zip ("No valid plugins were found") → upload the unpacked
  directory. The release workflow's changelog awk takes the first `= x.y.z =`
  → Upgrade Notice stays after Changelog.
- **2026-08-22 (dev loop)** — WordPress's Delete on the bind-mounted plugin
  `rm -rf`ed the source tree → never Delete it in Docker WP; test uninstall
  with `php -r`. `build-zip.sh` used to skip tests silently without `php` →
  now fails unless `PROMOVOLVE_ALLOW_UNVERIFIED=1`. Gutenberg + Playwright:
  `networkidle` never settles. LiteSpeed caches the 404 page → `?nocache=1`.
- **2026-08-22 (0.5.3)** — Registering the taxonomy without `show_in_rest`
  gives no sidebar box in the block editor.
- **2026-08-23 (0.5.4)** — A comment asserted the server's check order ("204
  = host gate passed") without reading the server; the order was the
  reverse. Verify claims about the other side of a contract against its
  source, and pin the mapping in a test (`verification probe` cases).

---

## 16. Glossary

| Term | Meaning here |
|---|---|
| **ad tag / loader** | `promovolve-ad.js` (built from `platform/banner-bootstrap`), the browser script that finds slots and talks to the ad server |
| **site ID (`data-pub`)** | the publisher site's identifier on Promovolve, usually the host with dots → dashes; public by design |
| **verified host** | the host the site proved it controls (file or DNS TXT); the serve host gate compares page URLs to it |
| **token** | the per-site verification secret printed at `/.well-known/promovolve.txt`; reissued when a site is removed and re-added |
| **stale / unknown / valid / unreachable** | the token-check states (§5.5) |
| **serving / foreign / missing / unknown** | the loopback check states (§7.3) |
| **present / foreign / missing / unreachable** | the dashboard's ownership re-check states (§7.4) — advisory |
| **slot ID** | `data-promovolve-slot` value; permanent dashboard inventory row; `<base>_<w>x<h>[suffix]` for block/auto, verbatim for shortcode |
| **scope** | `site` / `category` / `post` identity suffix rule |
| **topic hint / place hint** | `data-section` / `data-place`; unverified claims the classifier may use to disambiguate |
| **readable taxonomy** | `public && show_ui` and not in the deny list |
| **claim** | the per-request first-come reservation of a slot ID |
| **fuse** | how long a token state must stand before its admin notice shows (7 d unknown, 24 h stale) |
