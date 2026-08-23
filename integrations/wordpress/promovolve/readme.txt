=== Promovolve Publisher ===
Contributors: promovolve
Tags: ads, advertising, publisher
Requires at least: 6.0
Tested up to: 7.0
Requires PHP: 7.4
Stable tag: 0.5.5
License: Apache-2.0
License URI: https://www.apache.org/licenses/LICENSE-2.0

The minimum connection layer between a WordPress site and a Promovolve ad server.

== Description ==

This plugin does three things:

1. **Prints the Promovolve ad tag** on every front-end page, with the `data-pub`
   (site ID) and `data-api` (ads API base) attributes the loader requires.
2. **Serves the site-verification file** at `/.well-known/promovolve.txt` so the
   Promovolve dashboard can verify domain ownership — no FTP or file manager needed.
3. **Places ad slots** three ways:
   * the **Promovolve ad slot block** — drop it exactly where you want the ad in
     a post or page, in a Site Editor template or template part (one placement,
     every post), or in a block widget area. The block previews the real
     footprint, offers the common sizes, chooses its identity scope (shared /
     per category / per post), and warns when two slots on a page share an ID;
   * the `[promovolve_slot]` **shortcode** for the classic editor and theme
     templates;
   * an optional **automatic slot** appended after the content of single posts
     and pages, for blanket placement without editing anything. Its identity is
     configurable: one shared slot ID site-wide, one per WordPress category
     (recommended for blogs — keeps dashboard slot rows and ad pools topical),
     or one per post. On a block theme, putting the block in your Single
     template does the same job and lets you choose the position; on a classic
     theme there is no Site Editor, so this is the only way to cover every post
     without editing each one. The settings page recommends whichever applies
     to the theme you are running.

There is nothing else to configure. Slots need no pre-registration — they
self-activate on first serve. Page classification happens on demand from the
visitor's browser, so pages behind logins or noindex still work.

== Installation ==

1. Upload the `promovolve` folder to `/wp-content/plugins/`, or upload the zip
   via Plugins → Add New → Upload Plugin.
2. Activate the plugin.
3. On the Promovolve dashboard, register your site (its URL) and wait for
   operator approval.
4. In WordPress under Settings → Promovolve, fill in the Site ID, Ads API base
   URL, and ad loader script URL from your operator, and paste the verification
   token from the dashboard Sites page.
5. Back on the dashboard, click Verify.
6. Place slots with the "Promovolve ad slot" block (search for *Promovolve* in
   the block inserter), with `[promovolve_slot id="sidebar-top" w="300" h="250"]`,
   or by enabling the automatic after-content slot.

== Frequently Asked Questions ==

= I installed everything and see no ads. Is it broken? =

Usually not. Ads fill only after all of: the site request is approved by the
operator, the site is verified, and each winning creative is approved in your
dashboard Approval queue (or auto-approval for trusted advertisers is on).
Additionally, a brand-new page serves nothing on its first view(s) while it is
classified — that resolves by itself. The dashboard Sites page shows an
"Integration health" panel fed by the tag's heartbeat; `no_slots` there means
your theme stripped the slot markup, `no_fill` is healthy.

= Verification fails but the file URL works in my browser =

If WordPress lives in a subdirectory, the domain-root `/.well-known/` path
never reaches WordPress. Use the DNS TXT fallback shown on the settings page:
a TXT record at `_promovolve.<your-host>` with the value
`promovolve-site-verification=<token>`.

= Does each subdomain need its own setup? =

Yes. Promovolve treats every host as a separate site (only `www` and the bare
domain are merged), each with its own site ID, verification, and settings.

= What data does the tag collect? =

The tag sends the page URL and visible page text to the ads API once per new
page for on-demand ad targeting, plus anonymous delivery beacons. It stores
reader "dog-ear" bookmarks in the browser's IndexedDB: a bookmark lives until
its campaign ends (indefinitely for an open-ended campaign) and is dropped
when the reader unfolds it or does not revisit the page for 24 hours; it is
never synced anywhere. It sets no cookies and builds no reader
profile: the ad server selects ads from the page, never from the visitor, so
there is nothing for a Global Privacy Control signal to opt out of — ads
serve the same with or without it.

== Changelog ==

= 0.5.5 =
* Readme only: corrected the dog-ear retention statement. 0.5.4 said
  bookmarks are "kept for up to seven days"; a bookmark actually lives until
  its campaign ends (indefinitely for an open-ended campaign) and is dropped
  when the reader unfolds it or does not revisit the page for 24 hours. No
  code change.

= 0.5.4 =
* Fixed: the settings page could report a site as verified on an HTTP 204
  from the ad server. 204 means the site's organisation is suspended by the
  operator, and the server checks that before it checks verification, so it
  says nothing about verification either way — it is now treated as "no
  answer" rather than "verified".
* Removed the object-cache flush on settings save. It emptied the site's
  entire persistent object cache (and neighbours sharing a Redis without key
  prefixes) for no benefit — saving an option already refreshes that option's
  cache entry; the page-cache purges, which are what actually matter, are
  unchanged.
* Corrected the privacy statement in this readme: the ad server serves ads
  under the Global Privacy Control signal exactly as without it, because it
  selects from the page and holds no reader identity — there is nothing for
  the signal to opt out of. Dog-ear bookmarks are kept for up to seven days
  or until the campaign ends, whichever is sooner.
* The automatic-slot checkbox now says what the code does: it appends on
  every single view (posts, pages, custom post types), not only posts and
  pages.
* Comments that predated 0.5.0/0.5.2 (uninstall deleting settings; the
  verification check hiding the token field) brought up to date.

= 0.5.3 =
* **A built-in Destination taxonomy, one checkbox away.** Settings →
  Promovolve → Page context → “Destination taxonomy” registers a Destinations
  box in the post editor (slug `destination`, the one the plugin recommends),
  so a post can say which town or region it is about without anyone writing
  PHP. Type 金沢 on the Kanazawa post and that page sends its place to the ad
  server. Off by default — a site with its own destination/location taxonomy
  should not grow a second one, and the Context report says when it already
  qualifies. Turning it off again hides the box; WordPress keeps the terms.

= 0.5.2 =
* **The verification token field stays visible on a verified site.** 0.5.0
  and 0.5.1 hid it once the ad server reported the site verified, as "no
  longer needed" — which left a publisher restoring a lost token with
  nowhere to paste it, on exactly the day that became the thing to do. It
  is now shown on verified sites too, marked optional: verification is
  one-time and held by the ad server, but keeping the token filled is what
  makes the plugin answer the verification URL, which the dashboard
  re-checks when you open the site's details. The field says whether it is
  empty, current, or stale, and how to fetch the current token.

= 0.5.1 =
* **The plugin now asks the ad server whether its token is still the site's
  current one**, and stops serving the verification file when it is not.
  A site removed and added again on Promovolve gets a new token; until now
  the plugin kept serving the old one forever, with no way to know. It now
  answers 404 at `/.well-known/promovolve.txt` when the ad server says the
  token is stale (site re-added — paste the new token) or unknown (no such
  site — check the Site ID, or the request is still awaiting approval), and
  the settings screen says which. Nothing is deleted: the settings are kept
  either way, and the file is back the moment a current token is pasted.
* Fails open. If the ad server cannot be reached — network error, rate cap,
  an older server without the endpoint — the file is served as before,
  because it is also how a brand-new site gets verified.
* A dismissible admin notice after the token has been unknown for seven
  days, or stale for one, pointing at what to do — including, for a
  publisher who has left Promovolve, deleting the plugin with “Also delete
  these settings” ticked. Seven days, not five minutes: every benign cause
  (approval pending, a typo, a re-add in progress) resolves well inside it,
  and a notice that fires during setup teaches people to dismiss notices.
* Requires an ad server from 2026-08-22 or later for the check; against an
  older one the plugin behaves exactly as 0.5.0.

= 0.5.0 =
* **Your settings now survive deleting the plugin.** Deactivate → delete →
  upload is how plenty of upgrades are done, and until now it silently
  removed the site ID, API base, script URL and the verification token — the
  last copy of that token, since the dashboard stops showing it once a site
  is verified. The settings stay by default; a checkbox at the foot of
  Settings → Promovolve opts in to removing them, for the publisher who is
  genuinely finished.
* **Settings → Promovolve now shows what this site actually sends**, and
  whether any of its taxonomies count as places. Which slugs are read is a
  choice made here, not something a site can see from the outside: an author
  keeping towns in a taxonomy called `spot` had no way to learn that one
  filter line would make those towns targetable, and an author who already
  had `destination` had no way to know it was working. Both questions are now
  answered on the screen, against the site's own taxonomies, with one
  instruction up front and the full slug list folded away.
* **The recognised place slugs go well beyond `destination`.** Administrative
  units (`country`, `state`, `province`, `prefecture`, `region`, `county`,
  `municipality`, `city`, `town`, `village`), everyday wording (`location`,
  `place`, `area`, `locality`), units below a city that resolve up to the one
  around them (`district`, `neighborhood`, `borough`, `suburb`, `island`),
  and the slugs shipped by widely-installed plugins and themes where the term
  really is the page's subject — WP Job Manager's `job_listing_region`, WP
  Travel's `travel_locations`, directory `listing_city`, real-estate
  `property_city`. Store-locator and local-SEO taxonomies are deliberately
  NOT read: they hold the publisher's own address, not what the article is
  about.
* **`geo_address` is explained, with examples.** For the site that writes
  about a place twice a year and will not add a taxonomy for two posts: a
  custom field named `geo_address` holding a plain place name
  (`Kinosaki Onsen, Toyooka, Hyogo`; `金沢市, 石川県`) is read when no place
  taxonomy term is present. The screen shows how to add one and what not to
  put in it.
* Fixed: a `promovolve_topic_taxonomies` filter that removed a taxonomy from
  the topic hint also removed it from the place hint, silently. The two hints
  now enumerate independently; each has only its own filter.
* Fixed: the ad-tag attribute splice replaced every ` src=` in the tag rather
  than the first.

= 0.4.0 =
* **The tag now also tells the ad server what place a post is ABOUT.** A
  travel post filed under a `destination` taxonomy, or carrying WordPress's
  own `geo_address` meta, ships that as `data-place`. The server resolves the
  name against its own place vocabulary and can then match the article with
  advertising relevant to that destination.
* This is a property of the POST, never of the person reading it. That is
  what makes it safe to print into markup a page cache will store and replay
  to everyone: the answer does not vary by reader. The plugin does not and
  will not derive anything from a visitor's IP address — a value like that,
  captured by the same page cache, would be served to the world.
* Names are sent, not codes. The plugin has no place database and should not
  grow one; a publisher-supplied ISO code would be an unverified value
  dressed up as an authoritative one.
* New `promovolve_place_taxonomies` filter, for a site whose destination
  taxonomy is registered under a slug the defaults do not cover.

= 0.3.0 =
* **The topic hint now reads every taxonomy the post type has, not just
  categories and tags.** A travel site keeps its destinations in a
  `destination` taxonomy and a food site its `cuisine` — the most specific
  thing WordPress knew about a post was exactly the thing the plugin threw
  away. Only public, UI-visible taxonomies are read; internal plumbing
  (product visibility, menus, themes) and `post_format` are skipped, since
  "Aside" is a presentation choice and not a subject.
* Terms are now taken round-robin across taxonomies rather than one taxonomy
  at a time. A post with eight tags used to push everything else past the
  cap, so the taxonomy carrying the page's location never reached the server.
  Every taxonomy now contributes a term before any contributes a second.
* The cap rises from five names to eight, which is still far inside the
  bound the server applies to the hint.
* New `promovolve_topic_taxonomies` filter, for a site with a public
  taxonomy that is not a topic ("Author", "Sponsor") and wants it left out.

= 0.2.2 =
* **The tag now tells the ad server what WordPress already knows this page is
  about.** Classification works by sending the page's rendered text to a
  language model, which is fine for an article but poor for a category or tag
  archive, where the text is a blend of excerpts from unrelated posts.
  WordPress does not have to guess: a post's categories and tags are assigned
  facts, and an archive knows exactly which term it lists. The tag now carries
  that as `data-section`, and it is the one classification advantage this
  plugin has over pasting the script in by hand.
* It is a hint, never an answer. The server treats it as unverified and
  explicitly interested — a publisher earns more from some categories than
  others — so the page's own content stays the authority and a wrong or
  missing value costs nothing. Pages where WordPress has no honest single
  topic (front page, search, 404) send nothing at all and classify exactly as
  before.

= 0.2.1 =
* **The verification token field is gone once the site is verified.** The plugin
  now asks the ad server directly instead of guessing: the serve endpoint's host
  gate answers 403 for an unverified site, and it runs before the auction, so
  the check is free. An empty impression list keeps the verified case free too —
  it passes the gate, finds no slots, and returns an empty seatbid, so it can
  neither reserve budget nor enroll a slot id. Verified sites see a short "this
  site is verified" confirmation and nothing to fill in; unverified ones get the
  field plus a note that the server does not recognise them yet. The field
  reappears by itself if verification is ever lost, and any saved token survives
  a save while the field is hidden.
* The Site verification section now reports what `/.well-known/promovolve.txt`
  actually returns, instead of only showing what is saved here. Removing the
  plugin deletes its settings, so a reinstall leaves the token box empty while
  the file may still be served by something else — and an empty box read as
  "verification is broken" when it usually isn't. The live check distinguishes
  four cases: this plugin is serving the file; a token is served but from
  somewhere else (a leftover static file); nothing is served; and the check
  could not run because the host blocks loopback requests. A 200 response that
  is really an HTML catch-all page counts as "nothing served" — checking only
  the status code would report a file that does not exist.
* Made the token's lifecycle explicit: it is needed only until you click Verify,
  verification is one-time, and an already-verified site stays verified with the
  box empty. Removing the redundant "this plugin now serves the file" line,
  which the live check states more accurately.

= 0.2.0 =
* New **Promovolve ad slot** block. Place slots from the editor instead of
  settling for the after-content automatic slot: post and page content, Site
  Editor templates and template parts, and block widget areas all work. The
  block shows the ad's real footprint while editing, offers the common sizes
  (any custom size is fine too), supports the standard margin controls, and
  warns when another slot on the page already uses the same ID — a page fills
  only the first slot of any given ID.
* Block slots follow the automatic slot's identity rule: the effective
  dashboard ID is `<id>_<w>x<h>`, shown live in the block sidebar. Shortcode
  IDs are unchanged and still used verbatim.
* Blocks have the same **Slot identity** choice as the automatic slot — shared,
  per category, or per post. This matters for a block placed in a template,
  which is one placement rendering on every post: without it, such a slot could
  only ever be a single shared inventory row. The suffix applies on single posts
  and pages; on archives, where there is no unambiguous current post, the shared
  ID is used.
* A slot ID is now rendered at most **once per page**, whichever way it was
  placed. The ad loader has always filled only the first element with a given
  slot ID, so every repeat was dead markup that still reserved its box — an
  empty hole that could never fill. Archives hit this without anyone making a
  mistake: a theme that renders full post content repeated every in-content
  slot once per listed post. Responses that carry several renders at once (the
  REST API, feeds, editor previews) are deliberately exempt.
* The settings page now tailors its placement advice to your theme. "Put the
  block in your Single template" is impossible to follow on a classic theme,
  which has no Site Editor — there, the automatic slot is presented as the
  zero-touch option instead. On a block theme it is presented as the fallback
  for posts you would rather not edit.
* No new build step: the block ships as plain JavaScript, so the plugin folder
  remains copy-and-go.

= 0.1.3 =
* Slot containers are now sized inline (fill the content column up to the
  declared width, preserving aspect ratio, centered). Previously the bare
  div stretched to the theme's full column width, so a 300x250 slot rendered
  bloated. Applies to both the automatic slot and the shortcode.

= 0.1.2 =
* The automatic slot's configured size is now part of its identity: the
  effective slot ID is `<id>_<w>x<h>` (e.g. `article-footer_300x250`), plus
  the category/post suffix. Different sizes are different inventory — this
  keeps floor learning and ad pools per shape, and changing the size cleanly
  starts a fresh slot. NOTE: upgrading changes your automatic slot's ID once;
  the ad server enrolls the new ID on its first request and the old rows
  remain on the dashboard as history.
* Settings page shows the derived slot ID under the size fields.

= 0.1.1 =
* Settings saves now purge page caches on the FIRST save too (the purge was
  hooked only to option updates; WordPress fires a different hook when the
  option row is first created, so the initial configuration could be served
  stale from cache).
* Broader purge coverage: SiteGround Optimizer, WP Fastest Cache, Cache
  Enabler, Breeze, Hummingbird, WP-Optimize — in addition to LiteSpeed,
  WP Super Cache, W3 Total Cache, and WP Rocket.
* Settings page now notes that external caches/CDNs (e.g. Cloudflare page
  caching) must be purged separately.

= 0.1.0 =
* Initial release: ad tag injection, well-known verification route,
  slot shortcode, optional automatic after-content slot with configurable
  identity scope (shared / per category / per post).

== Upgrade Notice ==

= 0.5.5 =
Readme correction only; no behaviour change. Nothing to do after upgrading.

= 0.5.4 =
Small correctness release; nothing to do after upgrading. Upload with
"Replace current with uploaded"; settings are kept.

= 0.5.3 =
New: a Destination box for posts, one checkbox in Settings → Promovolve →
Page context. Optional; nothing changes until you tick it.

= 0.5.2 =
If your site is verified but its verification URL returns nothing, this
version gives you the field to fix it: Settings → Promovolve → paste the
token from the dashboard (Sites → the site → "Verification token") → save.

= 0.5.1 =
Upload with "Replace current with uploaded"; settings are kept. After
upgrading, the plugin will stop serving the verification file if the ad
server says the saved token is no longer this site's — the settings screen
tells you why and what to paste.

= 0.5.0 =
Upgrade with Plugins → Add New → Upload Plugin → "Replace current with
uploaded". That path keeps your settings. Deleting the plugin first used to
wipe them — including the verification token, which the dashboard no longer
shows once your site is verified; from this version they survive a delete
unless you tick the new "Also delete these settings" box.
