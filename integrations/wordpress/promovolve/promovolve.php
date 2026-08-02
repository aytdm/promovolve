<?php
/**
 * Plugin Name:       PromoVolve Publisher
 * Description:       Connects this site to a PromoVolve ad server: prints the ad tag, serves the site-verification file, and places ad slots via shortcode.
 * Version:           0.1.2
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            PromoVolve
 * License:           Apache-2.0
 * License URI:       https://www.apache.org/licenses/LICENSE-2.0
 * Text Domain:       promovolve
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const PROMOVOLVE_OPTION = 'promovolve_settings';

/**
 * Settings with defaults applied.
 *
 * @return array{site_id:string,api_base:string,script_url:string,verification_token:string,auto_slot_enabled:bool,auto_slot_id:string,auto_slot_w:int,auto_slot_h:int}
 */
function promovolve_settings() {
	$defaults = array(
		'site_id'            => '',
		'api_base'           => '',
		'script_url'         => '',
		'verification_token' => '',
		'auto_slot_enabled'  => false,
		'auto_slot_id'       => 'article-footer',
		'auto_slot_scope'    => 'site',
		'auto_slot_w'        => 728,
		'auto_slot_h'        => 90,
	);
	$saved = get_option( PROMOVOLVE_OPTION, array() );
	return array_merge( $defaults, is_array( $saved ) ? $saved : array() );
}

/**
 * The host PromoVolve treats as this site's identity: home host, lowercased,
 * one leading "www." stripped (www/apex are the same site; every other
 * subdomain is a separate site).
 */
function promovolve_canonical_host() {
	$host = strtolower( (string) wp_parse_url( home_url( '/' ), PHP_URL_HOST ) );
	return preg_replace( '/^www\./', '', $host );
}

/* -------------------------------------------------------------------------
 * Ad tag
 * ---------------------------------------------------------------------- */

add_action( 'wp_enqueue_scripts', function () {
	$s = promovolve_settings();
	if ( '' === $s['site_id'] || '' === $s['api_base'] || '' === $s['script_url'] ) {
		return;
	}
	// Version null: no ?ver= cache-buster — the stable loader alias carries
	// its own short max-age and must stay byte-addressable by URL.
	wp_enqueue_script( 'promovolve-ad', $s['script_url'], array(), null, false );
} );

add_filter( 'script_loader_tag', function ( $tag, $handle ) {
	if ( 'promovolve-ad' !== $handle ) {
		return $tag;
	}
	$s = promovolve_settings();
	// The loader reads document.currentScript, so the attributes must live on
	// the real <script src> tag itself.
	$attrs = sprintf(
		' data-pub="%s" data-api="%s" src=',
		esc_attr( $s['site_id'] ),
		esc_attr( $s['api_base'] )
	);
	return str_replace( ' src=', $attrs, $tag );
}, 10, 2 );

/* -------------------------------------------------------------------------
 * Site verification: /.well-known/promovolve.txt
 * ---------------------------------------------------------------------- */

add_action( 'init', function () {
	if ( empty( $_SERVER['REQUEST_URI'] ) ) {
		return;
	}
	$path = wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ), PHP_URL_PATH );
	if ( '/.well-known/promovolve.txt' !== $path ) {
		return;
	}
	$s = promovolve_settings();
	if ( '' === $s['verification_token'] ) {
		return; // No token configured — let WordPress 404 normally.
	}
	nocache_headers();
	header( 'Content-Type: text/plain; charset=utf-8' );
	echo 'promovolve-site-verification=' . $s['verification_token']; // phpcs:ignore WordPress.Security.EscapeOutput -- token is sanitized to [A-Za-z0-9-] on save, text/plain response.
	exit;
}, 1 );

/* -------------------------------------------------------------------------
 * Ad slots
 * ---------------------------------------------------------------------- */

/**
 * Slot container markup. The loader discovers these at DOMContentLoaded and
 * replaces the children on fill, so the div may stay empty.
 */
function promovolve_slot_html( $slot_id, $w, $h, $class = '' ) {
	$w = (int) $w;
	$h = (int) $h;
	if ( '' === $slot_id || $w < 1 || $h < 1 ) {
		return '';
	}
	$class_attr = '' !== $class ? sprintf( ' class="%s"', esc_attr( $class ) ) : '';
	return sprintf(
		'<div%s data-promovolve-slot="%s" data-w="%d" data-h="%d"></div>',
		$class_attr,
		esc_attr( $slot_id ),
		$w,
		$h
	);
}

add_shortcode( 'promovolve_slot', function ( $atts ) {
	$a = shortcode_atts(
		array(
			'id'    => '',
			'w'     => 0,
			'h'     => 0,
			'class' => '',
		),
		$atts,
		'promovolve_slot'
	);
	return promovolve_slot_html( $a['id'], $a['w'], $a['h'], $a['class'] );
} );

/**
 * Effective slot ID for the automatic slot on the current post.
 *
 * Every distinct slot ID becomes a permanent inventory row on the PromoVolve
 * dashboard and a separate ad candidate pool, so the scope is a real
 * granularity/cardinality trade-off:
 * - 'site':     one shared slot everywhere (least granular; ad pools and the
 *               dashboard category label blend all posts).
 * - 'category': one slot per WordPress category (bounded, topically coherent
 *               pools; recommended for blogs).
 * - 'post':     one slot per post (exact page attribution; a row and a cold
 *               ad pool per post — avoid on large sites).
 */
function promovolve_auto_slot_id( $s ) {
	// The configured size is part of the slot's identity (base_WxH): a
	// 728x90 strip and a 300x250 rectangle are different inventory even at
	// the same page position, and separate IDs keep floor learning and ad
	// pools per shape. Changing the size therefore starts a fresh slot —
	// the ad server enrolls it on its first request; the old size's
	// dashboard rows stay behind as history.
	$base = $s['auto_slot_id'] . '_' . (int) $s['auto_slot_w'] . 'x' . (int) $s['auto_slot_h'];
	if ( 'category' === $s['auto_slot_scope'] ) {
		$cats = get_the_category();
		if ( ! empty( $cats ) ) {
			$slug = strtolower( $cats[0]->slug );
			// Non-Latin category slugs are percent-encoded by WordPress and
			// would sanitize to opaque hex — key those by term ID instead.
			$suffix = preg_match( '/^[a-z0-9-]+$/', $slug ) ? $slug : 'cat' . $cats[0]->term_id;
			return $base . '-' . $suffix;
		}
		return $base; // No category (e.g. static pages): fall back to the shared slot.
	}
	if ( 'post' === $s['auto_slot_scope'] ) {
		return $base . '-post-' . get_the_ID();
	}
	return $base;
}

add_filter( 'the_content', function ( $content ) {
	$s = promovolve_settings();
	if ( ! $s['auto_slot_enabled'] || ! is_singular() || ! in_the_loop() || ! is_main_query() ) {
		return $content;
	}
	// Singular only: archives rendering full content would repeat the slot ID,
	// and the loader fills only the first match per page.
	return $content . promovolve_slot_html( promovolve_auto_slot_id( $s ), $s['auto_slot_w'], $s['auto_slot_h'] );
} );

/* -------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------- */

add_action( 'admin_init', function () {
	register_setting( 'promovolve', PROMOVOLVE_OPTION, array(
		'type'              => 'array',
		'sanitize_callback' => 'promovolve_sanitize_settings',
	) );
} );

/**
 * @param mixed $input Raw form input.
 * @return array Clean settings.
 */
function promovolve_sanitize_settings( $input ) {
	$input = is_array( $input ) ? $input : array();
	$clean = promovolve_settings();

	if ( isset( $input['site_id'] ) ) {
		$clean['site_id'] = preg_replace( '/[^a-z0-9-]/', '', strtolower( trim( (string) $input['site_id'] ) ) );
	}

	if ( isset( $input['api_base'] ) ) {
		$api = untrailingslashit( esc_url_raw( trim( (string) $input['api_base'] ) ) );
		// The loader appends /v1 itself; a pasted ".../v1" would double it.
		$api               = preg_replace( '#/v1$#', '', $api );
		$clean['api_base'] = untrailingslashit( $api );
	}

	if ( isset( $input['script_url'] ) ) {
		$clean['script_url'] = esc_url_raw( trim( (string) $input['script_url'] ) );
	}

	if ( isset( $input['verification_token'] ) ) {
		$token = trim( (string) $input['verification_token'] );
		// Accept the full "promovolve-site-verification=<token>" line or the bare token.
		$token                       = preg_replace( '/^promovolve-site-verification=/', '', $token );
		$clean['verification_token'] = preg_replace( '/[^A-Za-z0-9-]/', '', $token );
	}

	$clean['auto_slot_enabled'] = ! empty( $input['auto_slot_enabled'] );
	if ( isset( $input['auto_slot_id'] ) ) {
		$clean['auto_slot_id'] = sanitize_text_field( (string) $input['auto_slot_id'] );
	}
	if ( isset( $input['auto_slot_scope'] ) && in_array( $input['auto_slot_scope'], array( 'site', 'category', 'post' ), true ) ) {
		$clean['auto_slot_scope'] = $input['auto_slot_scope'];
	}
	if ( isset( $input['auto_slot_w'] ) ) {
		$clean['auto_slot_w'] = max( 0, (int) $input['auto_slot_w'] );
	}
	if ( isset( $input['auto_slot_h'] ) ) {
		$clean['auto_slot_h'] = max( 0, (int) $input['auto_slot_h'] );
	}

	return $clean;
}

/**
 * Settings changes alter front-end markup (the ad tag, slot IDs), which page
 * caches have already stored — on hosts like Hostinger, LiteSpeed caches pages
 * for days and the new setting silently never applies. Purge every cache we
 * can detect; each call is a no-op when that cache plugin is absent.
 */
function promovolve_purge_page_caches() {
	do_action( 'litespeed_purge_all' );
	if ( function_exists( 'wp_cache_clear_cache' ) ) {
		wp_cache_clear_cache(); // WP Super Cache
	}
	if ( function_exists( 'w3tc_flush_all' ) ) {
		w3tc_flush_all(); // W3 Total Cache
	}
	if ( function_exists( 'rocket_clean_domain' ) ) {
		rocket_clean_domain(); // WP Rocket
	}
	if ( function_exists( 'sg_cachepress_purge_cache' ) ) {
		sg_cachepress_purge_cache(); // SiteGround Optimizer
	}
	if ( function_exists( 'wpfc_clear_all_cache' ) ) {
		wpfc_clear_all_cache(); // WP Fastest Cache
	}
	if ( class_exists( 'Cache_Enabler' ) && method_exists( 'Cache_Enabler', 'clear_complete_cache' ) ) {
		Cache_Enabler::clear_complete_cache(); // Cache Enabler
	}
	do_action( 'breeze_clear_all_cache' );     // Breeze (Cloudways)
	do_action( 'wphb_clear_page_cache' );      // Hummingbird
	if ( function_exists( 'wpo_cache_flush' ) ) {
		wpo_cache_flush(); // WP-Optimize
	}
	if ( function_exists( 'wp_cache_flush' ) ) {
		wp_cache_flush(); // object cache (harmless, keeps option reads fresh)
	}
}

// BOTH hooks: WordPress fires add_option_* the FIRST time the option row is
// created and update_option_* thereafter — hooking only update means the
// very first configuration is served from cache and "doesn't apply".
add_action( 'add_option_' . PROMOVOLVE_OPTION, 'promovolve_purge_page_caches' );
add_action( 'update_option_' . PROMOVOLVE_OPTION, 'promovolve_purge_page_caches' );

add_action( 'admin_menu', function () {
	add_options_page(
		__( 'PromoVolve', 'promovolve' ),
		__( 'PromoVolve', 'promovolve' ),
		'manage_options',
		'promovolve',
		'promovolve_render_settings_page'
	);
} );

function promovolve_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$s    = promovolve_settings();
	$host = promovolve_canonical_host();

	$tag_preview = '';
	if ( '' !== $s['site_id'] && '' !== $s['api_base'] && '' !== $s['script_url'] ) {
		$tag_preview = sprintf(
			'<script data-pub="%s" data-api="%s" src="%s"></script>',
			esc_attr( $s['site_id'] ),
			esc_attr( $s['api_base'] ),
			esc_url( $s['script_url'] )
		);
	}
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'PromoVolve Publisher', 'promovolve' ); ?></h1>

		<form method="post" action="options.php">
			<?php settings_fields( 'promovolve' ); ?>

			<h2><?php esc_html_e( 'Connection', 'promovolve' ); ?></h2>
			<p><?php esc_html_e( 'All three values come from your PromoVolve operator. The ad tag is printed on every front-end page once all three are set.', 'promovolve' ); ?></p>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="promovolve-site-id"><?php esc_html_e( 'Site ID', 'promovolve' ); ?></label></th>
					<td>
						<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[site_id]" id="promovolve-site-id" type="text" class="regular-text code" value="<?php echo esc_attr( $s['site_id'] ); ?>" placeholder="<?php echo esc_attr( str_replace( '.', '-', $host ) ); ?>">
						<p class="description"><?php esc_html_e( 'Shown on the dashboard Sites page after your site is approved. Usually the domain with dots replaced by dashes.', 'promovolve' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="promovolve-api-base"><?php esc_html_e( 'Ads API base URL', 'promovolve' ); ?></label></th>
					<td>
						<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[api_base]" id="promovolve-api-base" type="url" class="regular-text code" value="<?php echo esc_attr( $s['api_base'] ); ?>" placeholder="https://ads.example.com">
						<p class="description"><?php esc_html_e( 'Scheme and host only — no /v1 suffix, no trailing slash (normalized on save).', 'promovolve' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="promovolve-script-url"><?php esc_html_e( 'Ad loader script URL', 'promovolve' ); ?></label></th>
					<td>
						<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[script_url]" id="promovolve-script-url" type="url" class="regular-text code" value="<?php echo esc_attr( $s['script_url'] ); ?>" placeholder="https://cdn.example.com/promovolve-ad.js">
						<p class="description"><?php esc_html_e( 'The stable promovolve-ad.js URL on your operator’s CDN.', 'promovolve' ); ?></p>
					</td>
				</tr>
			</table>

			<h2><?php esc_html_e( 'Site verification', 'promovolve' ); ?></h2>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="promovolve-token"><?php esc_html_e( 'Verification token', 'promovolve' ); ?></label></th>
					<td>
						<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[verification_token]" id="promovolve-token" type="text" class="regular-text code" value="<?php echo esc_attr( $s['verification_token'] ); ?>">
						<p class="description"><?php esc_html_e( 'Paste the token (or the full promovolve-site-verification=… line) from the dashboard Sites page, then click Verify there.', 'promovolve' ); ?></p>
						<?php if ( '' !== $s['verification_token'] ) : ?>
							<p class="description">
								<?php
								printf(
									/* translators: %s: verification file URL */
									esc_html__( 'This plugin now serves the verification file at %s.', 'promovolve' ),
									'<a href="' . esc_url( home_url( '/.well-known/promovolve.txt' ) ) . '" target="_blank"><code>' . esc_html( home_url( '/.well-known/promovolve.txt' ) ) . '</code></a>'
								);
								?>
							</p>
							<p class="description">
								<?php esc_html_e( 'DNS fallback if the file URL is unreachable (e.g. WordPress installed in a subdirectory):', 'promovolve' ); ?><br>
								<code>_promovolve.<?php echo esc_html( $host ); ?></code> TXT
								<code>promovolve-site-verification=<?php echo esc_html( $s['verification_token'] ); ?></code>
							</p>
						<?php endif; ?>
					</td>
				</tr>
			</table>

			<h2><?php esc_html_e( 'Ad slots', 'promovolve' ); ?></h2>
			<p>
				<?php esc_html_e( 'Place slots anywhere with the shortcode:', 'promovolve' ); ?>
				<code>[promovolve_slot id="sidebar-top" w="300" h="250"]</code>
			</p>
			<p class="description"><?php esc_html_e( 'Slot IDs are stable names you choose per site — no pre-registration needed. Use each ID at most once per page. Exact IAB sizes are not required; creatives scale into the box you declare.', 'promovolve' ); ?></p>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><?php esc_html_e( 'Automatic slot after post content', 'promovolve' ); ?></th>
					<td>
						<label>
							<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[auto_slot_enabled]" type="checkbox" value="1" <?php checked( $s['auto_slot_enabled'] ); ?>>
							<?php esc_html_e( 'Append an ad slot after the content on single posts and pages', 'promovolve' ); ?>
						</label>
						<p style="margin-top:8px;">
							<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[auto_slot_id]" type="text" class="code" value="<?php echo esc_attr( $s['auto_slot_id'] ); ?>" aria-label="<?php esc_attr_e( 'Slot ID', 'promovolve' ); ?>">
							<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[auto_slot_w]" type="number" min="1" style="width:6em;" value="<?php echo esc_attr( $s['auto_slot_w'] ); ?>" aria-label="<?php esc_attr_e( 'Width', 'promovolve' ); ?>"> ×
							<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[auto_slot_h]" type="number" min="1" style="width:6em;" value="<?php echo esc_attr( $s['auto_slot_h'] ); ?>" aria-label="<?php esc_attr_e( 'Height', 'promovolve' ); ?>">
						</p>
						<p class="description">
							<?php
							printf(
								/* translators: %s: the derived slot ID */
								esc_html__( 'The size is part of the slot identity — this configuration produces slot ID %s (plus the category/post suffix below). Changing the size starts a fresh slot with its own stats; the old size&#8217;s dashboard rows remain as history.', 'promovolve' ),
								'<code>' . esc_html( $s['auto_slot_id'] . '_' . (int) $s['auto_slot_w'] . 'x' . (int) $s['auto_slot_h'] ) . '</code>'
							);
							?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="promovolve-slot-scope"><?php esc_html_e( 'Automatic slot identity', 'promovolve' ); ?></label></th>
					<td>
						<select name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[auto_slot_scope]" id="promovolve-slot-scope">
							<option value="site" <?php selected( $s['auto_slot_scope'], 'site' ); ?>><?php esc_html_e( 'Shared — one slot ID on every post', 'promovolve' ); ?></option>
							<option value="category" <?php selected( $s['auto_slot_scope'], 'category' ); ?>><?php esc_html_e( 'Per category — slot ID + the post’s category slug', 'promovolve' ); ?></option>
							<option value="post" <?php selected( $s['auto_slot_scope'], 'post' ); ?>><?php esc_html_e( 'Per post — slot ID + the post ID', 'promovolve' ); ?></option>
						</select>
						<p class="description"><?php esc_html_e( 'Each distinct slot ID becomes its own row (with its own floor learning and ad pool) on the PromoVolve dashboard. Per category keeps that list small and topical — recommended for blogs. Per post gives exact page attribution but creates one row and one cold ad pool per post; avoid on large sites. Changing this later leaves the old slot rows behind on the dashboard.', 'promovolve' ); ?></p>
					</td>
				</tr>
			</table>

			<?php submit_button(); ?>
			<p class="description"><?php esc_html_e( 'Saving purges the page caches of known caching plugins automatically. If this site also sits behind an external cache or CDN (e.g. Cloudflare page caching, a host-level cache), purge that one too — otherwise visitors keep the old markup until it expires.', 'promovolve' ); ?></p>
		</form>

		<?php if ( '' !== $tag_preview ) : ?>
			<h2><?php esc_html_e( 'Active ad tag', 'promovolve' ); ?></h2>
			<p><?php esc_html_e( 'This tag is being printed in the head of every front-end page:', 'promovolve' ); ?></p>
			<pre style="background:#fff;border:1px solid #c3c4c7;padding:12px;overflow-x:auto;"><code><?php echo esc_html( $tag_preview ); ?></code></pre>
			<p class="description"><?php esc_html_e( 'Ads fill only after the site is approved and verified on the dashboard, and after each winning creative is approved in your Approval queue. Brand-new pages serve nothing on their first view while they classify — that is normal, not a fault.', 'promovolve' ); ?></p>
		<?php endif; ?>
	</div>
	<?php
}

add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), function ( $links ) {
	array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=promovolve' ) ) . '">' . esc_html__( 'Settings', 'promovolve' ) . '</a>' );
	return $links;
} );
