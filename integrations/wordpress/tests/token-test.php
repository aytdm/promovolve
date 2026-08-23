<?php
/**
 * Tests for the token check (docs/design/SITE_TOKEN_CHECK.md).
 *
 *   php integrations/wordpress/tests/token-test.php
 *
 * Same approach as topic-test.php: no WordPress, a stubbed core surface,
 * the plugin included, assertions on behaviour. What is pinned here is the
 * part that is easy to get wrong without noticing:
 *
 *   - the three server answers map to the three states, and ANYTHING else
 *     (network error, 429, 5xx, an older server's 404, a malformed body) is
 *     "unreachable" — which fails OPEN;
 *   - the cache is honoured, and dropped by a settings save;
 *   - the slow-burn bookkeeping resets on every state change, including to
 *     "unreachable", so a hiccup cannot keep a countdown running;
 *   - the token goes in the BODY of the request, never the URL.
 */

define( 'ABSPATH', __DIR__ );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'DAY_IN_SECONDS', 86400 );

$GLOBALS['tk'] = array(
	'transients' => array(),
	'options'    => array(),
	'response'   => null,   // what wp_remote_post returns next
	'last_post'  => null,   // what it was called with
	'now'        => 1_000_000,
);

// ── WordPress surface ────────────────────────────────────────────────────
function add_action( $hook, $cb = null, $p = 10, $n = 1 ) {}
function add_filter( $hook, $cb = null, $p = 10, $n = 1 ) {}
function add_shortcode( $tag, $cb ) {}
function plugin_basename( $file ) { return basename( $file ); }
function apply_filters( $hook, $value ) { return $value; }
function untrailingslashit( $s ) { return rtrim( $s, '/' ); }
function wp_json_encode( $v ) { return json_encode( $v ); }
function get_transient( $k ) { return $GLOBALS['tk']['transients'][ $k ] ?? false; }
function set_transient( $k, $v, $ttl = 0 ) { $GLOBALS['tk']['transients'][ $k ] = $v; return true; }
function delete_transient( $k ) { unset( $GLOBALS['tk']['transients'][ $k ] ); return true; }
function get_option( $k, $d = false ) { return $GLOBALS['tk']['options'][ $k ] ?? $d; }
function update_option( $k, $v, $autoload = null ) { $GLOBALS['tk']['options'][ $k ] = $v; return true; }
function is_wp_error( $x ) { return $x instanceof WP_Error; }
function wp_remote_retrieve_response_code( $r ) { return $r['response']['code'] ?? 0; }
function wp_remote_retrieve_body( $r ) { return $r['body'] ?? ''; }
function wp_remote_post( $url, $args ) {
	$GLOBALS['tk']['last_post'] = array( 'url' => $url, 'args' => $args );
	return $GLOBALS['tk']['response'];
}
function do_action( $hook ) {}
function function_exists_stub() {}
class WP_Error {}
// Stubs for functions the plugin file calls at load, in purge, or in the serve probe.
function home_url( $path = '' ) { return 'https://example.com' . $path; }

require_once __DIR__ . '/../promovolve/promovolve.php';

// ── harness ──────────────────────────────────────────────────────────────
$failures = 0;
function t( $label, $expected, $actual ) {
	global $failures;
	if ( $expected === $actual ) {
		echo "  ok   $label\n";
	} else {
		$failures++;
		echo "  FAIL $label\n       expected: " . var_export( $expected, true ) . "\n       actual:   " . var_export( $actual, true ) . "\n";
	}
}
function settings() {
	return array(
		'site_id'            => 'example-com',
		'api_base'           => 'https://ads.example.com/',
		'script_url'         => 'https://cdn.example.com/x.js',
		'verification_token' => 'tok-abc-123',
	);
}
function respond( $code, $body ) {
	$GLOBALS['tk']['response'] = array( 'response' => array( 'code' => $code ), 'body' => $body );
}
function reset_state() {
	$GLOBALS['tk']['transients'] = array();
	$GLOBALS['tk']['options']    = array();
	$GLOBALS['tk']['last_post']  = null;
}

echo "token-check\n";

// ── the three answers ─────────────────────────────────────────────────────
foreach ( array( 'valid', 'stale', 'unknown' ) as $state ) {
	reset_state();
	respond( 200, json_encode( array( 'state' => $state ) ) );
	t( "200 {state: $state} → $state", $state, promovolve_token_status( settings() ) );
}

// ── everything else is unreachable (fail open) ───────────────────────────
$unreachable = array(
	'network error'            => new WP_Error(),
	'429 rate cap'             => array( 'response' => array( 'code' => 429 ), 'body' => '{"code":"rate_limited"}' ),
	'503 entity unavailable'   => array( 'response' => array( 'code' => 503 ), 'body' => '{}' ),
	'404 older server'         => array( 'response' => array( 'code' => 404 ), 'body' => '' ),
	'200 with malformed body'  => array( 'response' => array( 'code' => 200 ), 'body' => 'not json' ),
	'200 with unexpected state' => array( 'response' => array( 'code' => 200 ), 'body' => '{"state":"deleted"}' ),
);
foreach ( $unreachable as $label => $resp ) {
	reset_state();
	$GLOBALS['tk']['response'] = $resp;
	t( "$label → unreachable", 'unreachable', promovolve_token_status( settings() ) );
}

// ── nothing to ask with ──────────────────────────────────────────────────
reset_state();
$GLOBALS['tk']['response'] = new WP_Error(); // would be unreachable anyway, but the point is: no call
$s = settings();
$s['verification_token'] = '';
t( 'no token configured → unreachable without asking', 'unreachable', promovolve_token_status( $s ) );
t( '  …and no request was made', null, $GLOBALS['tk']['last_post'] );

// ── request shape ────────────────────────────────────────────────────────
reset_state();
respond( 200, '{"state":"valid"}' );
promovolve_token_status( settings() );
$post = $GLOBALS['tk']['last_post'];
t( 'POSTs to /v1/sites/{siteId}/token-check with no trailing slash doubled',
	'https://ads.example.com/v1/sites/example-com/token-check', $post['url'] );
t( 'token travels in the body', '{"token":"tok-abc-123"}', $post['args']['body'] );
t( 'token is not in the URL', false, strpos( $post['url'], 'tok-abc-123' ) );

// ── cache ────────────────────────────────────────────────────────────────
reset_state();
respond( 200, '{"state":"stale"}' );
promovolve_token_status( settings() );
respond( 200, '{"state":"valid"}' ); // server now says valid…
t( 'cached answer is honoured within the window', 'stale', promovolve_token_status( settings() ) );
promovolve_purge_page_caches(); // …a settings save drops the cache…
t( 'a settings save drops the cache and re-asks', 'valid', promovolve_token_status( settings() ) );

// ── slow-burn bookkeeping ────────────────────────────────────────────────
reset_state();
respond( 200, '{"state":"unknown"}' );
promovolve_token_status( settings() );
$st1 = get_option( PROMOVOLVE_TOKEN_STATE_OPTION );
t( 'first unknown starts the clock', 'unknown', $st1['state'] ?? null );
$since1 = $st1['since'];
delete_transient( PROMOVOLVE_TOKEN_TRANSIENT );
promovolve_token_status( settings() ); // same answer again
t( 'same answer again keeps `since`', $since1, get_option( PROMOVOLVE_TOKEN_STATE_OPTION )['since'] );
delete_transient( PROMOVOLVE_TOKEN_TRANSIENT );
$GLOBALS['tk']['response'] = new WP_Error(); // hiccup
promovolve_token_status( settings() );
t( 'unreachable resets the state (a hiccup must not keep a countdown running)',
	'unreachable', get_option( PROMOVOLVE_TOKEN_STATE_OPTION )['state'] );
$st = get_option( PROMOVOLVE_TOKEN_STATE_OPTION );
$st['dismissed'] = true;
update_option( PROMOVOLVE_TOKEN_STATE_OPTION, $st );
delete_transient( PROMOVOLVE_TOKEN_TRANSIENT );
respond( 200, '{"state":"unknown"}' );
promovolve_token_status( settings() );
t( 'a state change clears a previous dismissal', false, get_option( PROMOVOLVE_TOKEN_STATE_OPTION )['dismissed'] );

// ── the serve probe (promovolve_verification_status) ─────────────────────
// 200 = passed the host gate with an empty imp; 403 = host gate refused;
// 204 = operator-suspended, which the server decides BEFORE the host gate,
// so it must not read as verified; everything else = no answer.
echo "\nverification probe\n";
$probe = array(
	array( 200, 'verified' ),
	array( 403, 'unverified' ),
	array( 204, 'unknown' ),
	array( 500, 'unknown' ),
	array( 429, 'unknown' ),
);
foreach ( $probe as $case ) {
	reset_state();
	respond( $case[0], $case[0] === 200 ? '{"seatbid":[]}' : '' );
	t( "serve/batch {$case[0]} → {$case[1]}", $case[1], promovolve_verification_status( settings() ) );
}
reset_state();
$GLOBALS['tk']['response'] = new WP_Error();
t( 'serve/batch network error → unknown', 'unknown', promovolve_verification_status( settings() ) );
t( '  …probe posts to /v1/serve/batch with an empty imp', true,
	substr( $GLOBALS['tk']['last_post']['url'], -15 ) === '/v1/serve/batch'
	&& json_decode( $GLOBALS['tk']['last_post']['args']['body'], true )['imp'] === array() );
reset_state();
t( 'no site_id → unknown without asking', 'unknown', promovolve_verification_status( array( 'site_id' => '', 'api_base' => 'https://x' ) ) );
t( '  …and no request was made', null, $GLOBALS['tk']['last_post'] );

// ── fuses ────────────────────────────────────────────────────────────────
t( 'unknown fuse is 7 days', 7 * DAY_IN_SECONDS, PROMOVOLVE_NOTICE_FUSE['unknown'] );
t( 'stale fuse is 24 hours', DAY_IN_SECONDS, PROMOVOLVE_NOTICE_FUSE['stale'] );
t( 'valid and unreachable have no fuse', false, isset( PROMOVOLVE_NOTICE_FUSE['valid'] ) || isset( PROMOVOLVE_NOTICE_FUSE['unreachable'] ) );

echo $failures ? "\n$failures failure(s)\n" : "\nall passed\n";
exit( $failures ? 1 : 0 );
