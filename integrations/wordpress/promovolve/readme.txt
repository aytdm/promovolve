=== PromoVolve Publisher ===
Contributors: promovolve
Tags: ads, advertising, publisher
Requires at least: 6.0
Tested up to: 7.0
Requires PHP: 7.4
Stable tag: 0.1.0
License: Apache-2.0
License URI: https://www.apache.org/licenses/LICENSE-2.0

The minimum connection layer between a WordPress site and a PromoVolve ad server.

== Description ==

This plugin does three things:

1. **Prints the PromoVolve ad tag** on every front-end page, with the `data-pub`
   (site ID) and `data-api` (ads API base) attributes the loader requires.
2. **Serves the site-verification file** at `/.well-known/promovolve.txt` so the
   PromoVolve dashboard can verify domain ownership — no FTP or file manager needed.
3. **Places ad slots**: a `[promovolve_slot]` shortcode for manual placement, plus
   an optional automatic slot appended after the content of single posts and pages.
   The automatic slot's identity is configurable: one shared slot ID site-wide,
   one per WordPress category (recommended for blogs — keeps dashboard slot rows
   and ad pools topical), or one per post.

There is nothing else to configure. Slots need no pre-registration — they
self-activate on first serve. Page classification happens on demand from the
visitor's browser, so pages behind logins or noindex still work.

== Installation ==

1. Upload the `promovolve` folder to `/wp-content/plugins/`, or upload the zip
   via Plugins → Add New → Upload Plugin.
2. Activate the plugin.
3. On the PromoVolve dashboard, register your site (its URL) and wait for
   operator approval.
4. In WordPress under Settings → PromoVolve, fill in the Site ID, Ads API base
   URL, and ad loader script URL from your operator, and paste the verification
   token from the dashboard Sites page.
5. Back on the dashboard, click Verify.
6. Place slots with `[promovolve_slot id="sidebar-top" w="300" h="250"]` or
   enable the automatic after-content slot.

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

Yes. PromoVolve treats every host as a separate site (only `www` and the bare
domain are merged), each with its own site ID, verification, and settings.

= What data does the tag collect? =

The tag sends the page URL and visible page text to the ads API once per new
page for on-demand ad targeting, plus anonymous delivery beacons. It stores
reader "dog-ear" bookmarks in the browser's IndexedDB (7-day expiry). It sets
no cookies. Visitors sending the Global Privacy Control signal receive no ads.

== Changelog ==

= 0.1.0 =
* Initial release: ad tag injection, well-known verification route,
  slot shortcode, optional automatic after-content slot with configurable
  identity scope (shared / per category / per post).
