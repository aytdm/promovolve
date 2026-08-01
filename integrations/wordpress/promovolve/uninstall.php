<?php
/**
 * Removes the single option PromoVolve Publisher stores.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'promovolve_settings' );
