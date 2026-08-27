<?php
/**
 * Plugin Name:       Promovolve Publisher
 * Description:       Connects this site to a Promovolve ad server: prints the ad tag, serves the site-verification file, and places ad slots via editor block or shortcode.
 * Version:           0.6.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Promovolve
 * License:           Apache-2.0
 * License URI:       https://www.apache.org/licenses/LICENSE-2.0
 * Text Domain:       promovolve
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const PROMOVOLVE_OPTION  = 'promovolve_settings';
const PROMOVOLVE_VERSION = '0.5.5';

/**
 * Settings with defaults applied.
 *
 * @return array{site_id:string,api_base:string,script_url:string,verification_token:string,auto_slot_enabled:bool,auto_slot_id:string,auto_slot_scope:string,auto_slot_w:int,auto_slot_h:int,destination_taxonomy:bool,delete_on_uninstall:bool}
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
		// Register a "Destination" taxonomy (slug `destination`) so a publisher
		// can file a post under the place it is about without writing PHP.
		// Off by default: a site that already has its own place taxonomy
		// should not grow a second one, and the Context panel says when it
		// already qualifies. Turning it off later hides the box but keeps
		// the terms (WordPress never deletes term data on unregister).
		'destination_taxonomy' => false,
		// Whether deleting the plugin also deletes this option. FALSE by
		// default, against the usual "clean up after yourself" instinct,
		// because of what the option holds: the verification token, which
		// the dashboard stops showing once the site is verified. Deleting
		// the plugin would destroy the last copy, and the only way back is
		// removing the site from Promovolve and re-adding it — a full
		// cascade purge, to undo a plugin upgrade. Leftover rows in
		// wp_options are the cheaper mistake by a wide margin.
		'delete_on_uninstall' => false,
	);
	$saved = get_option( PROMOVOLVE_OPTION, array() );
	return array_merge( $defaults, is_array( $saved ) ? $saved : array() );
}

/**
 * The host Promovolve treats as this site's identity: home host, lowercased,
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
	$section = promovolve_declared_topic();
	$place   = promovolve_declared_place();
	$attrs   = sprintf(
		' data-pub="%s" data-api="%s"%s%s src=',
		esc_attr( $s['site_id'] ),
		esc_attr( $s['api_base'] ),
		'' === $section ? '' : sprintf( ' data-section="%s"', esc_attr( $section ) ),
		'' === $place ? '' : sprintf( ' data-place="%s"', esc_attr( $place ) )
	);
	// Replace the FIRST ` src=` only: str_replace rewrites every occurrence,
	// so a tag carrying a second one (a filter appending an attribute, a
	// fallback src) would get the data-* attributes twice. The replacement
	// goes through a callback rather than preg_replace's replacement string
	// because that string interprets `$1` and `\1` — and $attrs carries a
	// publisher-set URL, which esc_attr does not strip `$` or `\` from.
	return preg_replace_callback(
		'/ src=/',
		static function () use ( $attrs ) {
			return $attrs;
		},
		$tag,
		1
	);
}, 10, 2 );

/**
 * The topic THIS page is about, according to WordPress itself.
 *
 * The ad server classifies pages by sending rendered text to an LLM. That
 * works, but WordPress already knows the answer for its own content: a post's
 * categories and tags are assigned facts, not inferences, and an archive knows
 * exactly which term it lists. Handing that over is the one classification
 * advantage this plugin has over a hand-pasted tag.
 *
 * It is a HINT, never an answer. The server treats it as an unverified,
 * interested claim — a publisher earns more from some categories than others —
 * and the page's own content stays the authority. So a blank or wrong value
 * costs nothing, which is why every branch here can safely return ''.
 *
 * Archives are the case that gains most: their rendered text is a blend of
 * excerpts from unrelated posts, so the term name is far better evidence than
 * anything the DOM offers.
 *
 * @return string Comma-separated topic list, or '' when WordPress has nothing
 *                confident to say (front page, 404, search results).
 */
function promovolve_declared_topic() {
	// Singular: every public taxonomy, not just category and post_tag — a
	// custom `destination` or `cuisine` is the most specific thing WP knows.
	if ( is_singular() ) {
		$post_id     = get_queried_object_id();
		$by_taxonomy = array();
		foreach ( promovolve_topic_taxonomies( $post_id ) as $taxonomy ) {
			$terms = get_the_terms( $post_id, $taxonomy );
			if ( ! is_array( $terms ) ) {
				continue; // no terms, or a WP_Error — either way, nothing to say
			}
			$names = array();
			foreach ( $terms as $term ) {
				if ( isset( $term->name ) ) {
					$names[] = $term->name;
				}
			}
			if ( ! empty( $names ) ) {
				$by_taxonomy[] = $names;
			}
		}
		return promovolve_join_topic( promovolve_interleave( $by_taxonomy ) );
	}

	// Category / tag / custom-taxonomy archive: the term IS the topic.
	if ( is_category() || is_tag() || is_tax() ) {
		$term = get_queried_object();
		return isset( $term->name ) ? promovolve_join_topic( array( $term->name ) ) : '';
	}

	// Everything else — front page, search, 404, date archives — has no
	// single honest topic. Say nothing rather than guess; the server then
	// classifies from content exactly as it does for a hand-embedded tag.
	return '';
}

/**
 * Taxonomy slugs that usually hold a PLACE rather than a topic.
 *
 * Matched on the slug, not the label, so a site can use its own wording
 * ("Reiseziel", "行き先") as long as the taxonomy is registered under one of
 * these. The filter below is the escape hatch for anything else.
 *
 * WHAT EARNS A SLUG A PLACE HERE
 *   Only that its terms are, in practice, somewhere an advertiser can buy.
 *   The server's targeting vocabulary is country → first-level subdivision →
 *   city, so a term naming any of those matches directly, and a term naming
 *   something SMALLER — a district, a neighbourhood, an onsen town — resolves
 *   up to the city or subdivision containing it. Both are worth sending.
 *   A slug is left out when its terms are usually NOT places at all
 *   ("venue" is often a business name, "market" a segment) or when they
 *   describe the publisher's own address rather than the article's subject
 *   (store locators, Yoast/Rank Math Local) — that is the confidently-wrong
 *   case this plugin exists to avoid.
 *
 * A wrong guess is cheap and a missing one is not: the hint reaches the
 * server labelled unverified and is ignored when the page text disagrees,
 * while a place taxonomy nobody recognised means a travel post about one town
 * competes as generic travel inventory. So the list leans inclusive.
 */
/**
 * The one slug to recommend when a site has no place taxonomy at all.
 *
 * Fifty-two slugs is a vocabulary, not an instruction. An author who needs
 * this feature needs to be told what to DO once; the rest of the list only
 * matters to the minority who already have a taxonomy and want to know
 * whether it counts.
 */
const PROMOVOLVE_PLACE_TAXONOMY_RECOMMENDED = 'destination';

/**
 * The same slugs, grouped for display only. Matching reads the flat list
 * below; this exists so the settings screen can explain the list instead of
 * dumping it. `place-taxonomy-groups-cover-the-list` in tests/topic-test.php
 * fails if the two ever drift — PHP 7.4 has no spread in constant arrays, so
 * a test is the only thing that can hold them together.
 */
const PROMOVOLVE_PLACE_TAXONOMY_GROUPS = array(
	'admin'   => array(
		'country', 'countries', 'state', 'states', 'province', 'provinces',
		'prefecture', 'prefectures', 'region', 'regions', 'county', 'counties',
		'municipality', 'municipalities', 'city', 'cities', 'town', 'towns',
		'village', 'villages',
	),
	'generic' => array(
		'destination', 'destinations', 'location', 'locations',
		'place', 'places', 'area', 'areas', 'locality', 'localities',
	),
	'sub'     => array(
		'district', 'districts', 'neighborhood', 'neighborhoods',
		'neighbourhood', 'neighbourhoods', 'borough', 'boroughs',
		'suburb', 'suburbs', 'island', 'islands',
	),
	'plugin'  => array(
		'job_listing_region', 'travel_locations', 'tour_location',
		'listing_city', 'listing_region', 'listing_location',
		'property_city', 'property_state', 'property_country', 'property_area',
	),
);

const PROMOVOLVE_PLACE_TAXONOMIES = array(
	// Administrative units — matched by the server's vocabulary directly.
	'country',
	'countries',
	'state',
	'states',
	'province',
	'provinces',
	'prefecture',
	'prefectures',
	'region',
	'regions',
	'county',
	'counties',
	'municipality',
	'municipalities',
	'city',
	'cities',
	'town',
	'towns',
	'village',
	'villages',

	// Generic wording for the same thing.
	'destination',
	'destinations',
	'location',
	'locations',
	'place',
	'places',
	'area',
	'areas',
	'locality',
	'localities',

	// Below city. No code of their own; they resolve to the city or
	// subdivision around them, which is exactly what Kinosaki Onsen needed.
	'district',
	'districts',
	'neighborhood',
	'neighborhoods',
	'neighbourhood',
	'neighbourhoods',
	'borough',
	'boroughs',
	'suburb',
	'suburbs',
	'island',
	'islands',

	// Slugs shipped by widely-installed plugins and themes, where the term
	// genuinely IS what the page is about: the region a job is in, the city a
	// listing sits in, the destination of a tour.
	'job_listing_region',   // WP Job Manager
	'travel_locations',     // WP Travel
	'tour_location',        // tour/travel themes
	'listing_city',         // directory themes
	'listing_region',
	'listing_location',
	'property_city',        // real-estate themes (Houzez, RealHomes, …)
	'property_state',
	'property_country',
	'property_area',
);

/**
 * Built-in place taxonomy (`destination`), for a site that has none.
 * Opt-in so a site with its own place taxonomy does not grow a second one;
 * show_in_rest is what puts the box in the block editor; switching it off
 * hides the box but WordPress keeps the terms.
 */
add_action( 'init', function () {
	$s = promovolve_settings();
	if ( empty( $s['destination_taxonomy'] ) || taxonomy_exists( 'destination' ) ) {
		return; // Off, or the site already has one of its own under this slug.
	}
	register_taxonomy( 'destination', array( 'post' ), array(
		'labels'            => array(
			'name'          => _x( 'Destinations', 'taxonomy general name', 'promovolve' ),
			'singular_name' => _x( 'Destination', 'taxonomy singular name', 'promovolve' ),
			'search_items'  => __( 'Search destinations', 'promovolve' ),
			'all_items'     => __( 'All destinations', 'promovolve' ),
			'edit_item'     => __( 'Edit destination', 'promovolve' ),
			'update_item'   => __( 'Update destination', 'promovolve' ),
			'add_new_item'  => __( 'Add new destination', 'promovolve' ),
			'new_item_name' => __( 'New destination', 'promovolve' ),
			'menu_name'     => __( 'Destinations', 'promovolve' ),
			'not_found'     => __( 'No destinations found.', 'promovolve' ),
		),
		'description'       => __( 'The place a post is about — a town, region or country. Promovolve sends it as the page’s place so advertisers targeting that destination can reach the article. Names in any language; the ad server resolves them.', 'promovolve' ),
		'public'            => true,
		'show_ui'           => true,
		'show_in_rest'      => true, // the block editor's sidebar box
		'show_admin_column' => true,
		'hierarchical'      => false,
		'rewrite'           => array( 'slug' => 'destination' ),
	) );
}, 5 ); // Before the default priority, so it exists by the time anything reads taxonomies.

/**
 * Where THIS page is about, according to WordPress.
 *
 * Note what this is and is not. It is a property of the POST — where the
 * article is set — and never anything about the person reading it. That is
 * what makes it safe to print into markup a page cache will store and replay
 * to everyone: the answer does not vary by reader. A value derived from a
 * visitor's IP would be captured by the same cache and served to the world,
 * which is why this plugin does not and will not carry one.
 *
 * Names, not codes. The plugin has no gazetteer and should not grow one — it
 * sends "Kyoto" or "京都" and the server resolves it against a vocabulary it
 * controls. A publisher-supplied ISO code would be an unverified value
 * dressed as an authoritative one.
 *
 * @return string Comma-separated place names, or '' when nothing is declared.
 */
function promovolve_declared_place() {
	if ( ! is_singular() ) {
		// On a place archive the term IS the place, and promovolve_declared_topic
		// already sends it as the topic; repeating it here adds nothing.
		return '';
	}

	$post_id = get_queried_object_id();

	/**
	 * Filter the taxonomy slugs treated as places.
	 *
	 * @param string[] $slugs   Taxonomy slugs.
	 * @param int      $post_id Post being rendered.
	 */
	$slugs = apply_filters( 'promovolve_place_taxonomies', PROMOVOLVE_PLACE_TAXONOMIES, $post_id );

	// Enumerated independently of the topic hint. Reading the topic list here
	// meant the `promovolve_topic_taxonomies` filter silently governed places
	// too: a site that removed `destination` from its TOPICS — a reasonable
	// "my destinations are not the subject" — also lost every place it had,
	// with nothing saying so. The two hints answer different questions and
	// have a filter each; only `promovolve_place_taxonomies` decides places.
	$by_taxonomy = array();
	foreach ( promovolve_readable_taxonomies( $post_id ) as $taxonomy ) {
		if ( ! in_array( $taxonomy, $slugs, true ) ) {
			continue;
		}
		$terms = get_the_terms( $post_id, $taxonomy );
		if ( ! is_array( $terms ) ) {
			continue;
		}
		$names = array();
		foreach ( $terms as $term ) {
			if ( isset( $term->name ) ) {
				$names[] = $term->name;
			}
		}
		if ( ! empty( $names ) ) {
			$by_taxonomy[] = $names;
		}
	}

	// WordPress's own geodata convention, as a fallback when no place
	// taxonomy exists. Free text, which is exactly what the server wants.
	// geo_latitude / geo_longitude are deliberately NOT read: coordinates
	// are out of scope, and reverse-geocoding them belongs on the server if
	// it ever happens at all.
	if ( empty( $by_taxonomy ) ) {
		$address = get_post_meta( $post_id, 'geo_address', true );
		if ( is_string( $address ) && '' !== trim( $address ) ) {
			$by_taxonomy[] = array( trim( $address ) );
		}
	}

	return promovolve_join_topic( promovolve_interleave( $by_taxonomy ) );
}

/**
 * Taxonomies whose terms are never a topic, however public they look.
 *
 * post_format yields "Aside" / "Gallery" — a presentation choice, not a
 * subject. Everything else is filtered structurally below.
 */
const PROMOVOLVE_TOPIC_TAXONOMY_DENY = array( 'post_format' );

/**
 * The taxonomies this post's type keeps topical terms in.
 *
 * Public and UI-visible is the structural test: the taxonomies that fail it
 * are plumbing (product_visibility, wp_theme, nav menus) and never describe
 * content. `category` and `post_tag` lead because their meaning is fixed on
 * every WordPress site; the rest are sorted so the attribute value is stable
 * across requests — a hint that reshuffled per request would vary the markup
 * for no gain.
 *
 * Widening this does admit noise: a public taxonomy named "Sponsor" or
 * "Author" is not a topic. That costs little — the server is told the whole
 * hint is an interested claim and to ignore it when the content disagrees —
 * and the filter below is the escape hatch for a site that wants one gone.
 *
 * @param int $post_id Post being rendered.
 * @return string[] Taxonomy names, in the order they should be read.
 */
function promovolve_topic_taxonomies( $post_id ) {
	$found = promovolve_readable_taxonomies( $post_id );

	$leading = array_values( array_intersect( array( 'category', 'post_tag' ), $found ) );
	$rest    = array_diff( $found, $leading );
	sort( $rest );

	/**
	 * Filter the taxonomies read for the data-section hint.
	 *
	 * @param string[] $taxonomies Taxonomy names, in read order.
	 * @param int      $post_id    Post being rendered.
	 */
	return apply_filters( 'promovolve_topic_taxonomies', array_merge( $leading, $rest ), $post_id );
}

/**
 * Every taxonomy on this post's type that describes CONTENT at all.
 *
 * The structural test both hints share, and nothing more: public and
 * UI-visible, minus the deny list. What fails it is plumbing —
 * product_visibility, wp_theme, nav menus — which never describes anything a
 * reader would recognise as a subject or a location.
 *
 * Deliberately unfiltered. The topic and place hints each narrow this in
 * their own way and each expose their own filter; a filter here would be a
 * third lever with authority over both, which is exactly the coupling that
 * made a topic filter silently disable place reading.
 *
 * @param int $post_id Post being rendered.
 * @return string[] Taxonomy names, registration order.
 */
function promovolve_readable_taxonomies( $post_id ) {
	$found = array();
	foreach ( get_object_taxonomies( get_post_type( $post_id ), 'objects' ) as $taxonomy ) {
		if ( empty( $taxonomy->public ) || empty( $taxonomy->show_ui ) ) {
			continue;
		}
		if ( in_array( $taxonomy->name, PROMOVOLVE_TOPIC_TAXONOMY_DENY, true ) ) {
			continue;
		}
		$found[] = $taxonomy->name;
	}
	return $found;
}

/**
 * What this SITE would send as context, for the settings screen.
 *
 * The place list is a convention nobody can see: an author with a `spot`
 * taxonomy full of towns has no way to learn that renaming it `destination`
 * (or adding one filter line) would make those towns matchable, and an author
 * who already has `destination` has no way to know it is working. A static
 * list in a readme answers neither question — this answers both, against the
 * taxonomies the site actually has.
 *
 * Site-wide rather than per-post: the settings screen has no post in hand, and
 * the useful question there is "does this site have a place taxonomy at all?"
 * The per-post read (promovolve_topic_taxonomies) stays the authority at
 * render time; this only mirrors its rules.
 *
 * @return array{place: WP_Taxonomy[], topic: WP_Taxonomy[]}
 */
function promovolve_context_taxonomies() {
	$slugs = apply_filters( 'promovolve_place_taxonomies', PROMOVOLVE_PLACE_TAXONOMIES, 0 );
	$out   = array(
		'place' => array(),
		'topic' => array(),
	);

	foreach ( get_taxonomies( array( 'public' => true ), 'objects' ) as $taxonomy ) {
		if ( empty( $taxonomy->show_ui ) || in_array( $taxonomy->name, PROMOVOLVE_TOPIC_TAXONOMY_DENY, true ) ) {
			continue;
		}
		$out[ in_array( $taxonomy->name, $slugs, true ) ? 'place' : 'topic' ][] = $taxonomy;
	}

	return $out;
}

/**
 * Round-robin per-taxonomy term lists into one.
 *
 * Concatenating them let a single taxonomy eat the whole budget: a post with
 * eight tags pushed its `destination` terms past the cap, so the one taxonomy
 * carrying the page's location never reached the server at all. Taking one
 * term from each list in turn means every taxonomy contributes before any
 * contributes twice, which is what makes the cap survivable.
 *
 * @param string[][] $lists Term names grouped by taxonomy.
 * @return string[]
 */
function promovolve_interleave( $lists ) {
	$deepest = 0;
	foreach ( $lists as $list ) {
		$deepest = max( $deepest, count( $list ) );
	}
	$out = array();
	for ( $i = 0; $i < $deepest; $i++ ) {
		foreach ( $lists as $list ) {
			if ( isset( $list[ $i ] ) ) {
				$out[] = $list[ $i ];
			}
		}
	}
	return $out;
}

/**
 * Join topic names for the data-section attribute.
 *
 * Bounded here as well as server-side: the server caps and flattens the value
 * because it must never trust a client, but a post with forty tags would
 * otherwise ship a long attribute on every page for a hint the server will
 * truncate anyway.
 *
 * Eight rather than five since the hint now spans several taxonomies — enough
 * for a category, a couple of tags and a destination to travel together, and
 * still far inside the server's own 200-character bound. The interleave above
 * is what decides WHICH eight.
 *
 * @param string[] $names Term names.
 * @return string
 */
function promovolve_join_topic( $names ) {
	$names = array_values( array_unique( array_filter( array_map( 'trim', $names ) ) ) );
	if ( empty( $names ) ) {
		return '';
	}
	return implode( ', ', array_slice( $names, 0, 8 ) );
}

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
	// Stop claiming a token that is no longer this site's. The ad server
	// is asked (and the answer cached) whether the stored token is still
	// current; "stale" (the site was removed and re-added on Promovolve and
	// has a new token) and "unknown" (no such site) both mean the honest
	// answer at this URL is nothing. The stored value is NOT touched — the
	// 404 is computed from the cached answer, so pasting a new token brings
	// the file back on the next request. "unreachable" serves the file:
	// this URL is also how a NEW site gets verified, and a hiccup at the ad
	// server must never hide it. See docs/design/SITE_TOKEN_CHECK.md.
	if ( in_array( promovolve_token_status( $s ), array( 'stale', 'unknown' ), true ) ) {
		// A real 404, not a fall-through: letting WordPress handle the URL
		// yields a 301 to a trailing-slash page, which is technically "no
		// record" but reads as a broken redirect to anyone who looks. The
		// plugin has claimed this URL and is declining to answer — say so.
		status_header( 404 );
		nocache_headers();
		header( 'Content-Type: text/plain; charset=utf-8' );
		exit;
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
	if ( '' === $slot_id || $w < 1 || $h < 1 || ! promovolve_slot_claim( $slot_id ) ) {
		return '';
	}
	$class_attr = '' !== $class ? sprintf( ' class="%s"', esc_attr( $class ) ) : '';
	return sprintf(
		'<div%s style="%s" data-promovolve-slot="%s" data-w="%d" data-h="%d"></div>',
		$class_attr,
		esc_attr( promovolve_slot_style( $w, $h ) ),
		esc_attr( $slot_id ),
		$w,
		$h
	);
}

/**
 * First-come claim on a slot ID for this request.
 *
 * The loader fills only the FIRST element with a given slot ID per page, so
 * every later one is dead markup that still reserves its box — an empty hole in
 * the layout that can never fill. Archives are where this bites without anyone
 * making a mistake: a theme that renders full post content repeats every
 * in-content slot once per listed post.
 *
 * Suppressing the repeats loses nothing (they could never have filled) and is
 * the same rule the loader already applies, moved earlier.
 *
 * @return bool True if the caller may render this slot.
 */
function promovolve_slot_claim( $slot_id ) {
	// One HTML document is one loader pass — that assumption is what makes the
	// claim safe. It does not hold for responses that carry several renders at
	// once (the REST API returning content.rendered for a list of posts, feeds,
	// editor previews), so leave those untouched.
	if ( is_admin() || wp_doing_ajax() || is_feed() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) ) {
		return true;
	}
	static $claimed = array();
	if ( isset( $claimed[ $slot_id ] ) ) {
		return false;
	}
	$claimed[ $slot_id ] = true;
	return true;
}

/**
 * Inline sizing for a slot container — the container is authoritative for the
 * rendered ad's size (the banner fills 100% of it), and a bare div stretches to
 * the theme's full content column: a 300x250 rendered ~700px wide. Same
 * contract as the reference publisher CSS: fill the column UP TO the declared
 * size, preserve the aspect ratio, centered.
 */
function promovolve_slot_style( $w, $h ) {
	return sprintf( 'display:block;width:100%%;max-width:%dpx;aspect-ratio:%d/%d;margin:16px auto;', (int) $w, (int) $w, (int) $h );
}

/**
 * The configured size is part of a slot's identity: a 728x90 strip and a
 * 300x250 rectangle are different inventory even at the same page position, and
 * separate IDs keep floor learning and ad pools per shape. Changing the size
 * therefore starts a fresh slot — the ad server enrolls it on its first
 * request; the old size's dashboard rows stay behind as history.
 *
 * Shared by the automatic slot and the editor block. The shortcode deliberately
 * does NOT apply it: shortcode IDs are written by hand and already live as
 * inventory rows, so rewriting them would orphan existing slots.
 */
function promovolve_sized_slot_id( $base, $w, $h ) {
	return $base . '_' . (int) $w . 'x' . (int) $h;
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
 * Identity suffix that splits one placement into several dashboard slots.
 *
 * Every distinct slot ID becomes a permanent inventory row on the Promovolve
 * dashboard and a separate ad candidate pool, so the scope is a real
 * granularity/cardinality trade-off:
 * - 'site':     one shared slot everywhere (least granular; ad pools and the
 *               dashboard category label blend all posts).
 * - 'category': one slot per WordPress category (bounded, topically coherent
 *               pools; recommended for blogs). The finest scope offered.
 *
 * A 'post' scope (one slot per post) existed through 0.5.x and was REMOVED
 * in 0.6.0 as a deliberate stance, not an oversight: the ad server learns
 * per slot — floor priors, quality scores, market rates, dog-ear pin reach
 * all accumulate on the slot ID — so per-post slots mint a permanent
 * dashboard row and a permanently cold ad pool per post, and gut a
 * reader's pin to a single URL. Page-level precision (which ad fits THIS
 * page) is the server's job at serve time, not the slot model's. A stored
 * 'post' setting or a saved block attribute degrades to the shared scope
 * below; the old per-post inventory rows simply go dormant.
 *
 * Shared by the automatic slot and the editor block. The block needs it for the
 * same reason the automatic slot does: placed in a Site Editor template it is
 * ONE placement rendering on every post, so without a scope it could only ever
 * be a single shared slot.
 */
function promovolve_slot_scope_suffix( $scope ) {
	if ( 'category' !== $scope ) {
		return '';
	}
	// Only a singular view has an unambiguous "current post": inside an archive
	// the global post is whichever one the loop last touched, so a per-post or
	// per-category suffix there would be arbitrary and would mint junk
	// inventory rows. Fall back to the shared ID.
	if ( ! is_singular() ) {
		return '';
	}
	$cats = get_the_category();
	if ( empty( $cats ) ) {
		return ''; // No category (e.g. static pages): fall back to the shared slot.
	}
	$slug = strtolower( $cats[0]->slug );
	// Non-Latin category slugs are percent-encoded by WordPress and would
	// sanitize to opaque hex — key those by term ID instead.
	return '-' . ( preg_match( '/^[a-z0-9-]+$/', $slug ) ? $slug : 'cat' . $cats[0]->term_id );
}

/**
 * Effective slot ID for the automatic slot on the current post.
 */
function promovolve_auto_slot_id( $s ) {
	return promovolve_sized_slot_id( $s['auto_slot_id'], $s['auto_slot_w'], $s['auto_slot_h'] )
		. promovolve_slot_scope_suffix( $s['auto_slot_scope'] );
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
 * Editor block
 * ---------------------------------------------------------------------- */

/**
 * The block is dynamic (render_callback, save() returns null): the front-end
 * markup lives in PHP alongside the shortcode's, so the two can never drift and
 * changing the container later does not invalidate already-saved posts.
 *
 * Registering it as a normal block means it is placeable everywhere the editor
 * reaches — post/page content, Site Editor templates and template parts, and
 * block widget areas — which is what the after-content automatic slot cannot do.
 */
add_action( 'init', function () {
	$block_dir = __DIR__ . '/blocks/slot';
	if ( ! function_exists( 'register_block_type' ) || ! file_exists( $block_dir . '/block.json' ) ) {
		return;
	}

	// No build step, so there is no generated *.asset.php to read dependencies
	// from — register the handle explicitly and let block.json reference it.
	wp_register_script(
		'promovolve-slot-block',
		plugins_url( 'blocks/slot/editor.js', __FILE__ ),
		array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-data', 'wp-i18n' ),
		PROMOVOLVE_VERSION,
		true
	);

	$s = promovolve_settings();
	wp_add_inline_script(
		'promovolve-slot-block',
		'window.promovolveBlock = ' . wp_json_encode(
			array(
				// Slots on an unconfigured site are inert markup — say so in the
				// editor rather than letting it look like a broken ad server.
				'configured'  => ( '' !== $s['site_id'] && '' !== $s['api_base'] && '' !== $s['script_url'] ),
				'settingsUrl' => admin_url( 'options-general.php?page=promovolve' ),
			)
		) . ';',
		'before'
	);

	register_block_type( $block_dir, array( 'render_callback' => 'promovolve_render_slot_block' ) );
} );

/**
 * @param array $attributes Block attributes.
 * @return string Slot container markup, or '' when the block is not usable.
 */
function promovolve_render_slot_block( $attributes ) {
	$attributes = is_array( $attributes ) ? $attributes : array();
	// Match the editor's sanitizer: slot IDs are inventory keys on the
	// dashboard, so keep them to a conservative alphabet on both sides.
	$base = preg_replace( '/[^a-z0-9-]/', '', strtolower( trim( (string) ( $attributes['slotId'] ?? '' ) ) ) );
	$w    = (int) ( $attributes['w'] ?? 0 );
	$h    = (int) ( $attributes['h'] ?? 0 );
	if ( '' === $base || $w < 1 || $h < 1 ) {
		return '';
	}
	$scope = (string) ( $attributes['scope'] ?? 'site' );
	// 'post' (removed 0.6.0) and anything unknown degrade to the shared scope.
	if ( ! in_array( $scope, array( 'site', 'category' ), true ) ) {
		$scope = 'site';
	}

	$slot_id = promovolve_sized_slot_id( $base, $w, $h ) . promovolve_slot_scope_suffix( $scope );
	if ( ! promovolve_slot_claim( $slot_id ) ) {
		return '';
	}

	// get_block_wrapper_attributes() carries the margin block support and the
	// editor's generated classes; our sizing goes first so a publisher's
	// explicit margin wins over the default. Alignment is deliberately NOT
	// supported: the slot is capped at its declared width, so "wide"/"full"
	// could not take effect and a float would fight width:100%.
	$wrapper = get_block_wrapper_attributes( array( 'style' => promovolve_slot_style( $w, $h ) ) );
	return sprintf(
		'<div %s data-promovolve-slot="%s" data-w="%d" data-h="%d"></div>',
		$wrapper, // phpcs:ignore WordPress.Security.EscapeOutput -- core-escaped attribute string.
		esc_attr( $slot_id ),
		$w,
		$h
	);
}

/* -------------------------------------------------------------------------
 * Verification-file probe
 * ---------------------------------------------------------------------- */

const PROMOVOLVE_WELLKNOWN_TRANSIENT = 'promovolve_wellknown_status';
const PROMOVOLVE_VERIFIED_TRANSIENT  = 'promovolve_verification_status';
const PROMOVOLVE_TOKEN_TRANSIENT     = 'promovolve_token_status';
// Separate option, not a key in promovolve_settings: writing the settings
// option fires promovolve_purge_page_caches (it is hooked on update_option),
// and this is bookkeeping the plugin writes on its own schedule. It must not
// purge a publisher's page cache every five minutes.
const PROMOVOLVE_TOKEN_STATE_OPTION  = 'promovolve_token_state';

/**
 * Is the token we hold still this site's current token, according to the
 * ad server? docs/design/SITE_TOKEN_CHECK.md.
 *
 *   valid        it is — serve the verification file as ever
 *   stale        the site exists but has a different token now: it was
 *                removed and re-added on Promovolve, which issues a new one
 *   unknown      the ad server knows no site with this ID (never created,
 *                still awaiting approval, or removed)
 *   unreachable  no answer we can act on — network error, 429, 5xx, or an
 *                older ad server without the endpoint (404)
 *
 * What the answer drives: whether /.well-known/promovolve.txt is served
 * (stale/unknown → 404) and what the settings screen says. What it never
 * drives: deleting anything. "unknown" also covers a mistyped Site ID and a
 * site still in the approval queue, and destroying the stored settings on
 * either would re-open the hole 0.5.0 closed.
 *
 * Fail OPEN on unreachable — the file is also how a NEW site gets verified.
 * Cached five minutes; the cache is dropped whenever settings are saved, so
 * a freshly pasted token takes effect on the next request.
 *
 * @return string valid | stale | unknown | unreachable
 */
function promovolve_token_status( $s ) {
	if ( '' === $s['site_id'] || '' === $s['api_base'] || '' === $s['verification_token'] ) {
		return 'unreachable'; // Nothing to ask with; behave as before.
	}
	$cached = get_transient( PROMOVOLVE_TOKEN_TRANSIENT );
	if ( is_string( $cached ) && '' !== $cached ) {
		return $cached;
	}

	$response = wp_remote_post(
		untrailingslashit( $s['api_base'] ) . '/v1/sites/' . rawurlencode( $s['site_id'] ) . '/token-check',
		array(
			'timeout' => 5,
			'headers' => array( 'Content-Type' => 'application/json' ),
			// Body, never query string: the token is a credential.
			'body'    => wp_json_encode( array( 'token' => $s['verification_token'] ) ),
		)
	);

	$state = 'unreachable';
	if ( ! is_wp_error( $response ) && 200 === (int) wp_remote_retrieve_response_code( $response ) ) {
		$decoded = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		if ( is_array( $decoded ) && isset( $decoded['state'] )
			&& in_array( $decoded['state'], array( 'valid', 'stale', 'unknown' ), true ) ) {
			$state = $decoded['state'];
		}
	}

	promovolve_record_token_state( $state );
	set_transient( PROMOVOLVE_TOKEN_TRANSIENT, $state, 5 * MINUTE_IN_SECONDS );
	return $state;
}

/**
 * Track how long the current answer has stood, for the slow-burn admin
 * notices. `since` is the first time the CURRENT state was seen; it resets
 * on any change, and "unreachable" resets it too — a server hiccup must not
 * keep a countdown running.
 *
 * @param string $state The answer just received.
 */
function promovolve_record_token_state( $state ) {
	$prev = get_option( PROMOVOLVE_TOKEN_STATE_OPTION, array() );
	$prev = is_array( $prev ) ? $prev : array();
	if ( ( $prev['state'] ?? '' ) === $state ) {
		return; // Unchanged — leave `since` and the dismissal alone.
	}
	update_option(
		PROMOVOLVE_TOKEN_STATE_OPTION,
		array(
			'state'     => $state,
			'since'     => time(),
			// A dismissal is remembered per state change: the notice returns
			// only if the answer flips to something else and back.
			'dismissed' => false,
		),
		false // no autoload
	);
}

/**
 * Ask the ad server whether this site is verified.
 *
 * The serve endpoint already answers this: its host gate replies 403
 * (BatchHostNotVerified) when the page URL's host does not match the site's
 * verified host — the site is unverified, the host differs, or the AdServer
 * entity does not yet know a verified host (right after an api restart,
 * before the DData publish lands; a transient false negative this cache
 * holds for up to five minutes). The gate runs BEFORE the auction, so an
 * unverified probe costs the server nothing. Sending an EMPTY impression list keeps the verified case just as
 * cheap — the request passes the gate, finds no slots to fill, and returns
 * `seatbid: []`, so it can neither reserve budget nor enroll a slot id. (It
 * does count as one request arrival, which is why the answer is cached and
 * only fetched when an admin opens this page.)
 *
 * Worth asking directly rather than inferring from the verification file:
 * verification is one-time and persisted server-side, so a site stays verified
 * long after the file stops being served — which is exactly what a
 * remove-and-reinstall of this plugin produces.
 *
 * @return string 'verified' | 'unverified' | 'unknown'
 */
function promovolve_verification_status( $s ) {
	if ( '' === $s['site_id'] || '' === $s['api_base'] ) {
		return 'unknown'; // Nothing to ask with.
	}
	$cached = get_transient( PROMOVOLVE_VERIFIED_TRANSIENT );
	if ( is_string( $cached ) && '' !== $cached ) {
		return $cached;
	}

	$response = wp_remote_post(
		untrailingslashit( $s['api_base'] ) . '/v1/serve/batch',
		array(
			'timeout' => 5,
			'headers' => array( 'Content-Type' => 'application/json' ),
			'body'    => wp_json_encode( array(
				'pub' => $s['site_id'],
				'url' => home_url( '/' ),
				'imp' => array(),
			) ),
		)
	);

	if ( is_wp_error( $response ) ) {
		$state = 'unknown';
	} else {
		$code = (int) wp_remote_retrieve_response_code( $response );
		if ( 200 === $code ) {
			$state = 'verified';
		} elseif ( 204 === $code ) {
			// 204 = operator-suspended (BatchSiteSuspended). The server checks
			// suspension BEFORE the host gate, so this says nothing about
			// verification either way: neither "verified" nor "unverified".
			// Suspension has its own dashboard surface; here it is simply no
			// answer.
			$state = 'unknown';
		} elseif ( 403 === $code ) {
			$state = 'unverified';
		} else {
			$state = 'unknown';
		}
	}

	// Short cache: this picks which verification guidance the settings page
	// shows, so a publisher who has just verified should see it change
	// promptly.
	set_transient( PROMOVOLVE_VERIFIED_TRANSIENT, $state, 5 * MINUTE_IN_SECONDS );
	return $state;
}

/**
 * What does the world ACTUALLY see at /.well-known/promovolve.txt?
 *
 * The settings field alone cannot answer that. The token box can be empty
 * (a pre-0.5.0 uninstall deleted it; a publisher cleared it; a fresh install)
 * while the file is still served by something else entirely — a static file
 * uploaded over FTP, or a previous install. An empty box then reads as
 * "verification is broken" when it usually isn't:
 * verification is one-time and persisted server-side, so an already-verified
 * site stays verified with no token here at all.
 *
 * Fetching the URL is the only way to state the real situation.
 *
 * @return array{state:string,token:string,code:int} state is one of
 *         'serving' | 'foreign' | 'missing' | 'unknown'.
 */
function promovolve_wellknown_status( $configured_token ) {
	$cached = get_transient( PROMOVOLVE_WELLKNOWN_TRANSIENT );
	if ( is_array( $cached ) ) {
		return $cached;
	}

	$url      = home_url( '/.well-known/promovolve.txt' );
	$response = wp_remote_get( $url, array( 'timeout' => 5, 'redirection' => 2 ) );

	if ( is_wp_error( $response ) ) {
		// Many hosts block loopback requests. Say so rather than reporting a
		// missing file — a wrong "not served" would send publishers chasing
		// a problem that isn't there.
		$status = array( 'state' => 'unknown', 'token' => '', 'code' => 0 );
	} else {
		$code = (int) wp_remote_retrieve_response_code( $response );
		$body = trim( (string) wp_remote_retrieve_body( $response ) );
		$hit  = array();
		if ( 200 === $code && preg_match( '/promovolve-site-verification=([A-Za-z0-9-]+)/', $body, $hit ) ) {
			$found = $hit[1];
			$status = array(
				// 'foreign' = a token is being served that this plugin is not
				// the source of. Worth distinguishing: it means the publisher
				// has a static file (or another install) doing the job.
				'state' => ( '' !== $configured_token && $found === $configured_token ) ? 'serving' : 'foreign',
				'token' => $found,
				'code'  => $code,
			);
		} else {
			$status = array( 'state' => 'missing', 'token' => '', 'code' => $code );
		}
	}

	set_transient( PROMOVOLVE_WELLKNOWN_TRANSIENT, $status, MINUTE_IN_SECONDS );
	return $status;
}

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
	// Unchecked checkboxes are absent from the POST, so this reads the
	// submitted form rather than falling through to the old value — that is
	// what lets the box be UNticked again.
	$clean['delete_on_uninstall'] = ! empty( $input['delete_on_uninstall'] );
	$clean['destination_taxonomy'] = ! empty( $input['destination_taxonomy'] );
	if ( isset( $input['auto_slot_id'] ) ) {
		$clean['auto_slot_id'] = sanitize_text_field( (string) $input['auto_slot_id'] );
	}
	if ( isset( $input['auto_slot_scope'] ) && in_array( $input['auto_slot_scope'], array( 'site', 'category' ), true ) ) {
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
	// The saved token decides whether we serve the verification file at all,
	// so the live probe's answer is stale the moment settings change.
	delete_transient( PROMOVOLVE_WELLKNOWN_TRANSIENT );
	// site_id / api_base are what the verification probe asks WITH, so a
	// settings change can invalidate its answer too.
	delete_transient( PROMOVOLVE_VERIFIED_TRANSIENT );
	// And the token check asks with the token itself: a freshly pasted token
	// must be re-checked on the next request, not in five minutes.
	delete_transient( PROMOVOLVE_TOKEN_TRANSIENT );
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
	// No wp_cache_flush() here: it empties the WHOLE persistent object cache
	// (Redis/Memcached — and every site sharing it without key prefixes) on
	// every save, and update_option already refreshes this option's own
	// cache entry. Page caches are what hold the old markup; those are above.
}

// BOTH hooks: WordPress fires add_option_* the FIRST time the option row is
// created and update_option_* thereafter — hooking only update means the
// very first configuration is served from cache and "doesn't apply".
add_action( 'add_option_' . PROMOVOLVE_OPTION, 'promovolve_purge_page_caches' );
add_action( 'update_option_' . PROMOVOLVE_OPTION, 'promovolve_purge_page_caches' );

/**
 * The slow-burn notices: "unknown" for 7 days, "stale" for 24 hours.
 *
 * Not on first sight, because every benign cause resolves well inside the
 * fuse — approval lands, the typo is fixed, the new token is pasted — and a
 * notice that fires during setup teaches publishers to dismiss notices.
 * Dismissal is remembered per state change (promovolve_record_token_state
 * resets it), so it returns only if the answer flips away and back.
 *
 * Nothing here deletes anything. The notice POINTS AT the explicit path for
 * a publisher who has genuinely left — delete the plugin with "Also delete
 * these settings" ticked — rather than inferring their intent.
 */
const PROMOVOLVE_NOTICE_FUSE = array(
	'unknown' => 7 * DAY_IN_SECONDS,
	'stale'   => DAY_IN_SECONDS,
);

add_action( 'admin_notices', function () {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$ts = get_option( PROMOVOLVE_TOKEN_STATE_OPTION, array() );
	if ( ! is_array( $ts ) || empty( $ts['state'] ) || ! empty( $ts['dismissed'] ) ) {
		return;
	}
	$state = $ts['state'];
	if ( ! isset( PROMOVOLVE_NOTICE_FUSE[ $state ] ) ) {
		return;
	}
	if ( time() - (int) ( $ts['since'] ?? time() ) < PROMOVOLVE_NOTICE_FUSE[ $state ] ) {
		return;
	}
	$settings_url = admin_url( 'options-general.php?page=promovolve' );
	$dismiss_url  = wp_nonce_url( add_query_arg( 'promovolve_dismiss_token_notice', '1' ), 'promovolve_dismiss_token_notice' );
	?>
	<div class="notice notice-warning">
		<p>
			<strong><?php esc_html_e( 'Promovolve:', 'promovolve' ); ?></strong>
			<?php
			if ( 'unknown' === $state ) {
				esc_html_e( 'the ad server has not recognised this site’s ID for a week. If you have left Promovolve, delete this plugin with “Also delete these settings” ticked and nothing will be left behind. If you have not, check the Site ID in the plugin settings, or add the site again on the dashboard.', 'promovolve' );
			} else {
				esc_html_e( 'the verification token saved here has not been this site’s current one for a day — usually because the site was removed and added again on Promovolve. Paste the new token from the dashboard Sites page into the plugin settings.', 'promovolve' );
			}
			?>
			<a href="<?php echo esc_url( $settings_url ); ?>"><?php esc_html_e( 'Open settings', 'promovolve' ); ?></a>
			&nbsp;·&nbsp;
			<a href="<?php echo esc_url( $dismiss_url ); ?>"><?php esc_html_e( 'Dismiss', 'promovolve' ); ?></a>
		</p>
	</div>
	<?php
} );

add_action( 'admin_init', function () {
	if ( empty( $_GET['promovolve_dismiss_token_notice'] ) || ! current_user_can( 'manage_options' ) ) {
		return;
	}
	check_admin_referer( 'promovolve_dismiss_token_notice' );
	$ts = get_option( PROMOVOLVE_TOKEN_STATE_OPTION, array() );
	if ( is_array( $ts ) && ! empty( $ts['state'] ) ) {
		$ts['dismissed'] = true;
		update_option( PROMOVOLVE_TOKEN_STATE_OPTION, $ts, false );
	}
	wp_safe_redirect( remove_query_arg( array( 'promovolve_dismiss_token_notice', '_wpnonce' ) ) );
	exit;
} );

add_action( 'admin_menu', function () {
	add_options_page(
		__( 'Promovolve', 'promovolve' ),
		__( 'Promovolve', 'promovolve' ),
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
	// wp_is_block_theme() landed in WP 5.9; the plugin header asks for 6.0, but
	// that header is advisory and hosts do run older cores.
	$block_theme = function_exists( 'wp_is_block_theme' ) && wp_is_block_theme();

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
		<h1><?php esc_html_e( 'Promovolve Publisher', 'promovolve' ); ?></h1>

		<form method="post" action="options.php">
			<?php settings_fields( 'promovolve' ); ?>

			<h2><?php esc_html_e( 'Connection', 'promovolve' ); ?></h2>
			<p><?php esc_html_e( 'All three values come from your Promovolve operator. The ad tag is printed on every front-end page once all three are set.', 'promovolve' ); ?></p>
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
			<?php
			$verification = promovolve_verification_status( $s );
			if ( 'verified' === $verification ) :
				// Verified: nothing here is REQUIRED any more — verification is
				// one-time and held by the ad server — but the token field stays,
				// because keeping it filled is what keeps this plugin serving the
				// verification file, and the dashboard re-checks for that file
				// when the site's details are opened. 0.5.0/0.5.1 hid the field
				// on verified sites as "no longer needed", which left a publisher
				// restoring a lost token with nowhere to paste it. Optional, and
				// said so.
				?>
				<p style="padding:8px 10px;border-left:4px solid #00a32a;background:#fff;max-width:46em;">
					<strong><?php esc_html_e( 'This site is verified.', 'promovolve' ); ?></strong>
					<?php esc_html_e( 'Verification is one-time and held by the ad server; nothing below is required for ads to serve. Keeping the token here is still worth it: it is what makes this plugin answer the verification URL, which the dashboard re-checks whenever you open the site’s details.', 'promovolve' ); ?>
				</p>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="promovolve-token"><?php esc_html_e( 'Verification token', 'promovolve' ); ?></label></th>
						<td>
							<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[verification_token]" id="promovolve-token" type="text" class="regular-text code" value="<?php echo esc_attr( $s['verification_token'] ); ?>">
							<?php
							$token_state = promovolve_token_status( $s );
							if ( '' === $s['verification_token'] ) :
								?>
								<p class="description" style="padding:8px 10px;border-left:4px solid #dba617;background:#fff;">
									<?php esc_html_e( 'Empty — the verification URL currently answers nothing, and the dashboard will say so when you open this site’s details. Optional to fix. To restore it: dashboard → Sites → expand this site → “Verification token” → Copy, paste here, save.', 'promovolve' ); ?>
								</p>
							<?php elseif ( 'stale' === $token_state ) : ?>
								<p class="description" style="padding:8px 10px;border-left:4px solid #dba617;background:#fff;">
									<?php esc_html_e( 'This token is no longer the site’s current one, so the plugin answers 404 at the verification URL. Copy the current one from the dashboard Sites page (“Verification token” under the site’s details) and paste it here.', 'promovolve' ); ?>
								</p>
							<?php elseif ( 'valid' === $token_state ) : ?>
								<p class="description" style="padding:8px 10px;border-left:4px solid #00a32a;background:#fff;">
									<?php esc_html_e( 'Token current — the plugin is answering the verification URL with it.', 'promovolve' ); ?>
								</p>
							<?php endif; ?>
							<p class="description"><?php esc_html_e( 'Optional on a verified site. Leave it filled so the verification file stays up; clear it only if you want the URL to stop answering.', 'promovolve' ); ?></p>
						</td>
					</tr>
				</table>
			<?php else : ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="promovolve-token"><?php esc_html_e( 'Verification token', 'promovolve' ); ?></label></th>
					<td>
						<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[verification_token]" id="promovolve-token" type="text" class="regular-text code" value="<?php echo esc_attr( $s['verification_token'] ); ?>">
						<?php
						// The token check says WHY the site is not verified with this
						// token, where the serve probe can only say that it is not.
						// Both "stale" and "unknown" stop the plugin serving the file;
						// the difference is what the publisher should do about it.
						$token_state = promovolve_token_status( $s );
						if ( 'stale' === $token_state ) :
							?>
							<p class="description" style="padding:8px 10px;border-left:4px solid #dba617;background:#fff;">
								<?php esc_html_e( 'This token is no longer the site’s current one — usually because the site was removed and added again on Promovolve, which issues a new token. Until a current token is pasted here, the plugin answers 404 at the verification URL rather than serve a token that is not this site’s. Copy the new one from the dashboard Sites page.', 'promovolve' ); ?>
							</p>
						<?php elseif ( 'unknown' === $token_state ) : ?>
							<p class="description" style="padding:8px 10px;border-left:4px solid #dba617;background:#fff;">
								<?php esc_html_e( 'The ad server knows no site with this Site ID. If the site request is still waiting for approval, nothing is wrong — this resolves when it is approved. Otherwise check the Site ID above, or add the site again on the dashboard. The verification URL answers 404 meanwhile. Your settings are kept either way.', 'promovolve' ); ?>
							</p>
						<?php elseif ( 'unverified' === $verification ) : ?>
							<p class="description" style="padding:8px 10px;border-left:4px solid #dba617;background:#fff;">
								<?php esc_html_e( 'The ad server does not recognise this site as verified yet. Paste the token below, then click Verify on the dashboard Sites page.', 'promovolve' ); ?>
							</p>
						<?php endif; ?>
						<p class="description"><?php esc_html_e( 'Needed only until you click Verify on the dashboard — verification is one-time. An already-verified site stays verified even with this box empty, so a blank field after reinstalling the plugin is not a fault.', 'promovolve' ); ?></p>
						<p class="description"><?php esc_html_e( 'Paste the token (or the full promovolve-site-verification=… line) from the dashboard Sites page, then click Verify there.', 'promovolve' ); ?></p>

						<?php
						// Ground truth beats the saved setting: report what the
						// URL actually returns right now.
						$wk     = promovolve_wellknown_status( $s['verification_token'] );
						$wk_url = home_url( '/.well-known/promovolve.txt' );
						$link   = '<a href="' . esc_url( $wk_url ) . '" target="_blank"><code>' . esc_html( $wk_url ) . '</code></a>';
						?>
						<p class="description" style="margin-top:10px;padding:8px 10px;border-left:4px solid <?php
							echo esc_attr( 'missing' === $wk['state'] ? '#dba617' : ( 'unknown' === $wk['state'] ? '#c3c4c7' : '#00a32a' ) );
						?>;background:#fff;">
							<?php
							switch ( $wk['state'] ) {
								case 'serving':
									printf(
										/* translators: %s: verification file URL */
										esc_html__( 'Live check: this plugin is serving the verification file at %s.', 'promovolve' ),
										$link // phpcs:ignore WordPress.Security.EscapeOutput -- built from esc_url/esc_html above.
									);
									break;
								case 'foreign':
									printf(
										/* translators: 1: verification file URL, 2: the token found there */
										esc_html__( 'Live check: %1$s already returns a token (%2$s), but it is not coming from this plugin — most likely a static file left on the server. Verification will work as-is. Paste that token above only if you want the plugin to own the file.', 'promovolve' ),
										$link, // phpcs:ignore WordPress.Security.EscapeOutput -- built from esc_url/esc_html above.
										'<code>' . esc_html( $wk['token'] ) . '</code>'
									);
									break;
								case 'missing':
									printf(
										/* translators: %s: verification file URL */
										esc_html__( 'Live check: %s returns nothing. That only matters if this site is not verified yet — check the dashboard Sites page. If it already shows as verified, no action is needed.', 'promovolve' ),
										$link // phpcs:ignore WordPress.Security.EscapeOutput -- built from esc_url/esc_html above.
									);
									break;
								default:
									printf(
										/* translators: %s: verification file URL */
										esc_html__( 'Live check: could not reach %s from this server (many hosts block loopback requests). Open it in a browser tab to see what visitors get.', 'promovolve' ),
										$link // phpcs:ignore WordPress.Security.EscapeOutput -- built from esc_url/esc_html above.
									);
							}
							?>
						</p>
						<?php if ( '' !== $s['verification_token'] ) : ?>
							<p class="description">
								<?php esc_html_e( 'DNS fallback if the file URL is unreachable (e.g. WordPress installed in a subdirectory):', 'promovolve' ); ?><br>
								<code>_promovolve.<?php echo esc_html( $host ); ?></code> TXT
								<code>promovolve-site-verification=<?php echo esc_html( $s['verification_token'] ); ?></code>
							</p>
						<?php endif; ?>
					</td>
				</tr>
			</table>
			<?php endif; // verified / not-verified verification sections ?>

			<h2><?php esc_html_e( 'Ad slots', 'promovolve' ); ?></h2>
			<p>
				<?php
				// Only a block theme has a Site Editor, so "put one block in your
				// Single template" is advice that simply cannot be followed on a
				// classic theme — where the automatic slot below is instead the
				// only way to cover every post without editing them.
				if ( $block_theme ) {
					esc_html_e( 'Place a slot where you want it with the “Promovolve ad slot” block — in a post or page, in a Site Editor template or template part (one placement, every post), or in a block widget area.', 'promovolve' );
				} else {
					esc_html_e( 'Place a slot where you want it with the “Promovolve ad slot” block — in a post or page, or in a block widget area.', 'promovolve' );
				}
				?>
			</p>
			<p>
				<?php esc_html_e( 'Classic editor or theme templates, use the shortcode:', 'promovolve' ); ?>
				<code>[promovolve_slot id="sidebar-top" w="300" h="250"]</code>
			</p>
			<p class="description"><?php esc_html_e( 'Slot IDs are stable names you choose per site — no pre-registration needed. A given ID renders at most once per page — repeats are dropped, since the loader could only ever fill the first one, and the block warns you about them in the editor. Exact IAB sizes are not required; creatives scale into the box you declare. Block slots append the size to the ID and offer the same identity scope as the automatic slot below; shortcode IDs are used verbatim.', 'promovolve' ); ?></p>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><?php esc_html_e( 'Automatic slot after post content', 'promovolve' ); ?></th>
					<td>
						<label>
							<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[auto_slot_enabled]" type="checkbox" value="1" <?php checked( $s['auto_slot_enabled'] ); ?>>
							<?php esc_html_e( 'Append an ad slot after the content on single posts, pages and other single views', 'promovolve' ); ?>
						</label>
						<p class="description">
							<?php
							if ( $block_theme ) {
								esc_html_e( 'A blanket placement for existing posts you do not want to edit. Your theme is a block theme, so putting the block in your Single template gives the same coverage and lets you choose the position — prefer that. If you use both, give them different IDs: a page fills only the first slot of any given ID.', 'promovolve' );
							} else {
								esc_html_e( 'The zero-touch option on your theme: classic themes have no Site Editor, so this is the only way to place a slot on every post without editing each one. If you also place blocks in post content, give them different IDs: a page fills only the first slot of any given ID.', 'promovolve' );
							}
							?>
						</p>
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
						</select>
						<p class="description"><?php esc_html_e( 'Each distinct slot ID becomes its own row (with its own floor learning and ad pool) on the Promovolve dashboard. Per category keeps that list small and topical — recommended for blogs. Per post gives exact page attribution but creates one row and one cold ad pool per post; avoid on large sites. Changing this later leaves the old slot rows behind on the dashboard.', 'promovolve' ); ?></p>
					</td>
				</tr>
			</table>

			<h2><?php esc_html_e( 'Page context', 'promovolve' ); ?></h2>
			<p><?php esc_html_e( 'Every ad request carries what WordPress already knows about the page — its topic from categories and tags, and the place it is about from a place taxonomy — so the article can be matched before a language model has read a word of it. Both describe the post, never the reader. The report below the form shows what this site sends.', 'promovolve' ); ?></p>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><?php esc_html_e( 'Destination taxonomy', 'promovolve' ); ?></th>
					<td>
						<label>
							<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[destination_taxonomy]" type="checkbox" value="1" <?php checked( $s['destination_taxonomy'] ); ?>>
							<?php esc_html_e( 'Add a “Destination” box to the post editor, so each post can say which place it is about', 'promovolve' ); ?>
						</label>
						<p class="description"><?php esc_html_e( 'For a site that writes about places and has no place taxonomy of its own. Tick it, save, then open a post: a Destinations box appears in the sidebar — type the town or region (金沢, Kanazawa, any language) and update. That page then tells the ad server its place, which is what lets an advertiser targeting that destination reach it. Leave it off if your theme already has a destination/location taxonomy — the report below will list it under Place. Turning it off later hides the box but keeps what you typed.', 'promovolve' ); ?></p>
					</td>
				</tr>
			</table>

			<h2><?php esc_html_e( 'If you delete this plugin', 'promovolve' ); ?></h2>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><?php esc_html_e( 'Settings on delete', 'promovolve' ); ?></th>
					<td>
						<label>
							<input name="<?php echo esc_attr( PROMOVOLVE_OPTION ); ?>[delete_on_uninstall]" type="checkbox" value="1" <?php checked( $s['delete_on_uninstall'] ); ?>>
							<?php esc_html_e( 'Also delete these settings when the plugin is deleted', 'promovolve' ); ?>
						</label>
						<p class="description"><?php esc_html_e( 'Off by default, and worth leaving off. Deleting a plugin is how many upgrades are done — deactivate, delete, upload the new zip — and it would take the verification token with it. Promovolve stops showing that token once your site is verified, so the copy above is the only one left; without it, re-integrating means removing the site from Promovolve and adding it again. Left off, the settings simply wait here for the new version. Tick it only when you are finished with Promovolve and want nothing left behind.', 'promovolve' ); ?></p>
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

		<?php
		// What this site sends as context, and — the part no readme can
		// answer — whether its own taxonomies qualify. Read-only: nothing
		// here is a setting, because the answer lives in how the site
		// registered its taxonomies, not in an option this plugin owns.
		$context = promovolve_context_taxonomies();
		$labels  = static function ( $taxonomies ) {
			$out = array();
			foreach ( $taxonomies as $taxonomy ) {
				$out[] = '<strong>' . esc_html( $taxonomy->labels->singular_name ) . '</strong> <code>' . esc_html( $taxonomy->name ) . '</code>';
			}
			return implode( ', ', $out );
		};
		?>
		<h2><?php esc_html_e( 'Context this site sends', 'promovolve' ); ?></h2>
		<p><?php esc_html_e( 'Every ad request carries what WordPress already knows about the page, so it can be matched before a language model has read a word of it. Both are properties of the POST — what it is about and where it is set — never anything about the person reading it.', 'promovolve' ); ?></p>

		<table class="form-table" role="presentation">
			<tr>
				<th scope="row"><?php esc_html_e( 'Topic', 'promovolve' ); ?></th>
				<td>
					<?php if ( ! empty( $context['topic'] ) ) : ?>
						<p><?php echo wp_kses_post( $labels( $context['topic'] ) ); ?></p>
						<p class="description"><?php esc_html_e( 'Terms from these taxonomies are sent as the topic hint. Every public taxonomy counts, not only categories and tags — the place taxonomies below included, whose terms go out both ways: a destination archive is a page about that place as a subject too.', 'promovolve' ); ?></p>
					<?php else : ?>
						<p class="description"><?php esc_html_e( 'None — pages are classified from their text alone, which works.', 'promovolve' ); ?></p>
					<?php endif; ?>
				</td>
			</tr>
			<tr>
				<th scope="row"><?php esc_html_e( 'Place', 'promovolve' ); ?></th>
				<td>
					<?php if ( ! empty( $context['place'] ) ) : ?>
						<p><?php echo wp_kses_post( $labels( $context['place'] ) ); ?></p>
						<p class="description"><?php esc_html_e( 'Terms from these are sent as the place hint — a post filed under one of them tells the ad server which town or region the article is about, which is what lets an advertiser buy that destination specifically. Term names are sent exactly as you wrote them, in any language; term slugs are never read. While these exist, the geo_address fallback below is not consulted: a term you filed deliberately outranks a stray custom field.', 'promovolve' ); ?></p>
					<?php else : ?>
						<p class="description">
							<?php
							printf(
								/* translators: %s: the recommended taxonomy slug, in <code> */
								esc_html__( 'None yet. If your posts are about somewhere, tick “Destination taxonomy” in the form above and save — that adds a Destination box to the post editor, and filing each post under the town or region it covers is the whole setup. (Any taxonomy registered under the slug %s works the same way.)', 'promovolve' ),
								'<code>' . esc_html( PROMOVOLVE_PLACE_TAXONOMY_RECOMMENDED ) . '</code>'
							);
							?>
						</p>
						<p class="description"><?php esc_html_e( 'It is worth doing: a travel or local site whose destinations exist only in prose competes as generic inventory, while one that files them can be bought by an advertiser targeting that exact town. The label is yours — 行き先, Reiseziel, anything — only the slug is matched.', 'promovolve' ); ?></p>

						<?php
						// The per-post escape hatch, spelled out. A taxonomy is
						// the right answer for a site that publishes about
						// places regularly; geo_address is for the site that
						// does so occasionally and will not restructure its
						// content for one post.
						?>
						<p class="description" style="margin-top:10px;">
							<strong><?php esc_html_e( 'One-off posts: the geo_address custom field', 'promovolve' ); ?></strong><br>
							<?php esc_html_e( 'A taxonomy is overkill for a site that mentions a place twice a year. Where a post has no place taxonomy term, this plugin falls back to a custom field named geo_address — WordPress\'s own long-standing convention for "where is this post about", written by geo plugins such as Simple Location and readable by hand. Put a plain place name in it, most specific first, the way you would write it on an envelope. It is a property of the post, so it is safe under page caching, and it is only read on single posts and pages.', 'promovolve' ); ?>
						</p>
						<table class="widefat striped" style="max-width:46em;margin:4px 0 8px;">
							<thead>
								<tr>
									<th style="width:11em;"><?php esc_html_e( 'Custom field', 'promovolve' ); ?></th>
									<th><?php esc_html_e( 'Value', 'promovolve' ); ?></th>
									<th style="width:14em;"><?php esc_html_e( 'What the server resolves', 'promovolve' ); ?></th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td><code>geo_address</code></td>
									<td><code>Kinosaki Onsen, Toyooka, Hyogo</code></td>
									<td><?php esc_html_e( 'the town of Toyooka — the onsen district resolves up to the city around it', 'promovolve' ); ?></td>
								</tr>
								<tr>
									<td><code>geo_address</code></td>
									<td><code>金沢市, 石川県</code></td>
									<td><?php esc_html_e( 'Kanazawa — names in any language are fine', 'promovolve' ); ?></td>
								</tr>
							</tbody>
						</table>
						<p class="description">
							<?php esc_html_e( 'To add it by hand: open the post, choose Preferences from the editor’s ⋮ menu, switch on Custom fields, then add a field named geo_address with the place as its value. Write a place, not a street address or coordinates — geo_latitude and geo_longitude are deliberately ignored, and a postcode narrows nothing an advertiser can buy. Do not put your own business address here: what the article is ABOUT is the question, not where you are.', 'promovolve' ); ?>
						</p>
					<?php endif; ?>

					<?php
					// The full vocabulary, folded away. It answers one
					// question — "does the taxonomy I already have count?" —
					// and printing all of it inline buried the single
					// instruction most authors need under fifty-two slugs.
					$groups = array(
						'admin'   => __( 'Administrative units', 'promovolve' ),
						'generic' => __( 'Everyday wording for the same thing', 'promovolve' ),
						'sub'     => __( 'Smaller than a city — resolved up to the city or region around it', 'promovolve' ),
						'plugin'  => __( 'Shipped by common plugins and themes', 'promovolve' ),
					);
					$extra = array_values( array_diff(
						apply_filters( 'promovolve_place_taxonomies', PROMOVOLVE_PLACE_TAXONOMIES, 0 ),
						PROMOVOLVE_PLACE_TAXONOMIES
					) );
					$code_list = static function ( $slugs ) {
						return '<code>' . implode( '</code> <code>', array_map( 'esc_html', $slugs ) ) . '</code>';
					};
					?>
					<details style="margin-top:10px;">
						<summary style="cursor:pointer;"><?php esc_html_e( 'All slugs read as places', 'promovolve' ); ?></summary>
						<table class="widefat striped" style="margin-top:8px;max-width:46em;">
							<tbody>
								<?php foreach ( $groups as $key => $label ) : ?>
									<tr>
										<td style="width:16em;"><?php echo esc_html( $label ); ?></td>
										<td><?php echo wp_kses_post( $code_list( PROMOVOLVE_PLACE_TAXONOMY_GROUPS[ $key ] ) ); ?></td>
									</tr>
								<?php endforeach; ?>
								<?php if ( ! empty( $extra ) ) : ?>
									<tr>
										<td><?php esc_html_e( 'Added on this site by a filter', 'promovolve' ); ?></td>
										<td><?php echo wp_kses_post( $code_list( $extra ) ); ?></td>
									</tr>
								<?php endif; ?>
							</tbody>
						</table>
						<p class="description"><?php esc_html_e( 'Store-locator and local-SEO taxonomies are deliberately not read: they hold your own business address, not what the article is about.', 'promovolve' ); ?></p>
						<p class="description"><?php esc_html_e( 'Keep places under a slug that is not listed? Point the plugin at it instead of renaming anything:', 'promovolve' ); ?></p>
						<pre style="background:#fff;border:1px solid #c3c4c7;padding:8px;overflow-x:auto;margin:4px 0 0;"><code>add_filter( 'promovolve_place_taxonomies', function ( $slugs ) {
	$slugs[] = 'your-taxonomy-slug';
	return $slugs;
} );</code></pre>
					</details>
				</td>
			</tr>
		</table>
		<p class="description"><?php esc_html_e( 'Both hints are evidence, never the answer: the ad server treats them as an unverified claim, uses them only to settle what the page text already supports, and ignores them when the text disagrees. A place name is resolved against the server’s own vocabulary — the plugin never sends a code.', 'promovolve' ); ?></p>
	</div>
	<?php
}

add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), function ( $links ) {
	array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=promovolve' ) ) . '">' . esc_html__( 'Settings', 'promovolve' ) . '</a>' );
	return $links;
} );
