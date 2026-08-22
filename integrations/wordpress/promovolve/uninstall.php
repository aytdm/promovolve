<?php
/**
 * Runs when the plugin is DELETED (not deactivated).
 *
 * It deliberately keeps the plugin's option unless the publisher asked for it
 * to go. The usual advice is to clean up everything, and the usual advice is
 * wrong here because of one field: the verification token. Promovolve's
 * dashboard stops showing that token once the site is verified, so this option
 * holds the last copy of it. Deleting the plugin — which is how WordPress
 * upgrades look to plenty of people: deactivate, delete, upload the new zip —
 * would destroy it, and the only route back is removing the site from
 * Promovolve and adding it again, which purges everything about the site
 * except its earnings. A few leftover rows in wp_options are cheaper than
 * that by any measure.
 *
 * Settings → Promovolve has a checkbox for the publisher who really is
 * finished and wants nothing left behind; that is what this reads. The option
 * is read directly because the plugin's own functions are not loaded during
 * uninstall.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

$promovolve_settings = get_option( 'promovolve_settings' );

if ( is_array( $promovolve_settings ) && ! empty( $promovolve_settings['delete_on_uninstall'] ) ) {
	delete_option( 'promovolve_settings' );
}

// Transients are pure cache — the live verification/well-known probes refill
// them on the next admin page load — so they go regardless.
delete_transient( 'promovolve_wellknown_status' );
delete_transient( 'promovolve_verification_status' );
