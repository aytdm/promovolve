<?php
/**
 * Removes the single option Promovolve Publisher stores.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'promovolve_settings' );
