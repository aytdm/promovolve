/**
 * Editor implementation of the promovolve/slot block.
 *
 * Deliberately plain ES5 with wp.element.createElement instead of JSX: the
 * plugin ships as a copy-and-go folder with no build step, so this file is the
 * artifact — there is no bundle to regenerate. Block metadata (title, icon,
 * attributes, supports) comes from block.json via the server-side registration;
 * only edit/save live here.
 *
 * The block is dynamic — save() returns null and PHP renders the container, so
 * changing the markup later never invalidates already-saved posts.
 */
( function ( wp ) {
	'use strict';

	if ( ! wp || ! wp.blocks || ! wp.element || ! wp.blockEditor ) {
		return;
	}

	var el                = wp.element.createElement;
	var Fragment          = wp.element.Fragment;
	var __                = wp.i18n.__;
	var sprintf           = wp.i18n.sprintf;
	var useBlockProps     = wp.blockEditor.useBlockProps;
	var InspectorControls = wp.blockEditor.InspectorControls;
	var PanelBody         = wp.components.PanelBody;
	var TextControl       = wp.components.TextControl;
	var SelectControl     = wp.components.SelectControl;
	var Notice            = wp.components.Notice;
	var ExternalLink      = wp.components.ExternalLink;
	var useSelect         = wp.data.useSelect;

	var config = window.promovolveBlock || {};

	// Common shapes as a starting point. Exact IAB sizes are not required —
	// creatives scale into whatever box is declared — so "Custom" is a
	// first-class choice, not an escape hatch.
	var SIZES = [
		{ w: 300, h: 250, label: __( 'Medium rectangle — 300 × 250', 'promovolve' ) },
		{ w: 336, h: 280, label: __( 'Large rectangle — 336 × 280', 'promovolve' ) },
		{ w: 728, h: 90, label: __( 'Leaderboard — 728 × 90', 'promovolve' ) },
		{ w: 970, h: 250, label: __( 'Billboard — 970 × 250', 'promovolve' ) },
		{ w: 320, h: 50, label: __( 'Mobile banner — 320 × 50', 'promovolve' ) },
		{ w: 300, h: 600, label: __( 'Half page — 300 × 600', 'promovolve' ) },
		{ w: 160, h: 600, label: __( 'Wide skyscraper — 160 × 600', 'promovolve' ) }
	];

	// Mirrors the automatic slot's identity scopes. It matters most for a block
	// living in a Site Editor template: that is ONE placement rendering on every
	// post, so without a scope it could only ever be a single shared slot.
	var SCOPES = [
		{ value: 'site', label: __( 'Shared — one slot everywhere', 'promovolve' ), token: '' },
		{ value: 'category', label: __( 'Per category — split by the post’s category', 'promovolve' ), token: '-<category>' }
	];

	function scopeToken( scope ) {
		for ( var i = 0; i < SCOPES.length; i++ ) {
			if ( SCOPES[ i ].value === scope ) {
				return SCOPES[ i ].token;
			}
		}
		return '';
	}

	/**
	 * Slot IDs travel to the ad server as inventory keys and appear verbatim on
	 * the dashboard, so keep them to a conservative alphabet. Sanitizing on
	 * change (rather than on render) keeps the editor honest: what the panel
	 * shows is exactly what the front end emits.
	 */
	function sanitizeId( raw ) {
		return String( raw === undefined || raw === null ? '' : raw )
			.toLowerCase()
			.replace( /[^a-z0-9-]/g, '' );
	}

	/**
	 * The size is part of the slot's identity, matching the automatic slot:
	 * a leaderboard and a rectangle are different inventory even in the same
	 * position, and separate IDs keep floor learning and ad pools per shape.
	 */
	function sizedId( base, w, h ) {
		base = sanitizeId( base );
		if ( '' === base ) {
			return '';
		}
		return base + '_' + parseInt( w, 10 ) + 'x' + parseInt( h, 10 );
	}

	function collectSlots( blocks, out ) {
		( blocks || [] ).forEach( function ( block ) {
			if ( 'promovolve/slot' === block.name ) {
				out.push( block );
			}
			if ( block.innerBlocks && block.innerBlocks.length ) {
				collectSlots( block.innerBlocks, out );
			}
		} );
		return out;
	}

	function sizeSelectValue( w, h ) {
		var match = SIZES.some( function ( s ) {
			return s.w === w && s.h === h;
		} );
		return match ? w + 'x' + h : 'custom';
	}

	wp.blocks.registerBlockType( 'promovolve/slot', {
		edit: function ( props ) {
			var a         = props.attributes;
			var scope     = a.scope || 'site';
			var effective = sizedId( a.slotId, a.w, a.h );
			// The scope suffix is resolved at render time from the post being
			// viewed, so the editor can only show its shape.
			var displayId = '' === effective ? '' : effective + scopeToken( scope );

			// The loader fills only the FIRST match per page, so a second block
			// resolving to the same ID is silently dead markup. Catch it here
			// rather than letting the publisher discover it as "no ads". Two
			// blocks sharing an ID but scoped differently only collide when both
			// suffixes are empty, which the scope token captures.
			var duplicate = useSelect( function ( select ) {
				var editor = select( 'core/block-editor' );
				if ( ! editor || '' === effective ) {
					return false;
				}
				return collectSlots( editor.getBlocks(), [] ).some( function ( block ) {
					var other = sizedId( block.attributes.slotId, block.attributes.w, block.attributes.h );
					return block.clientId !== props.clientId &&
						'' !== other &&
						other + scopeToken( block.attributes.scope || 'site' ) === displayId;
				} );
			}, [ displayId, effective, props.clientId ] );

			// A non-positive size renders nothing on the front end, so the editor
			// must not show a confident-looking slot. Reachable by hand-editing
			// the block markup — the number controls clamp to 1.
			var rawW   = parseInt( a.w, 10 );
			var rawH   = parseInt( a.h, 10 );
			var sizeOk = rawW > 0 && rawH > 0;
			var w      = sizeOk ? rawW : 300;
			var h      = sizeOk ? rawH : 250;
			var valid  = '' !== effective && sizeOk;

			// Same box contract as the front end: fill the column up to the
			// declared width, preserve the aspect ratio, centered — so what the
			// editor shows is the footprint the ad will actually occupy.
			var blockProps = useBlockProps( {
				style: {
					display: 'block',
					width: '100%',
					maxWidth: w + 'px',
					aspectRatio: w + ' / ' + h,
					margin: '16px auto'
				}
			} );

			var placeholder = el(
				'div',
				{
					style: {
						boxSizing: 'border-box',
						height: '100%',
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						justifyContent: 'center',
						gap: '2px',
						padding: '6px',
						overflow: 'hidden',
						textAlign: 'center',
						lineHeight: 1.3,
						border: '1px dashed ' + ( duplicate || ! valid ? '#cc1818' : '#949494' ),
						borderRadius: '4px',
						background: 'repeating-linear-gradient(45deg, rgba(0,0,0,.03) 0 8px, transparent 8px 16px)',
						color: '#50575e',
						fontSize: '12px'
					}
				},
				el( 'strong', { style: { fontSize: '12px' } }, __( 'Promovolve ad slot', 'promovolve' ) ),
				! sizeOk
					? el( 'em', { style: { color: '#cc1818' } }, __( 'Set a width and height', 'promovolve' ) )
					: '' === effective
						? el( 'em', { style: { color: '#cc1818' } }, __( 'Set a slot ID', 'promovolve' ) )
						: el( 'code', { style: { fontSize: '11px', background: 'transparent' } }, displayId ),
				duplicate
					? el( 'span', { style: { color: '#cc1818' } }, __( 'Duplicate ID on this page', 'promovolve' ) )
					: null,
				config.configured === false
					? el( 'span', { style: { color: '#bd8600' } }, __( 'Plugin not configured', 'promovolve' ) )
					: null
			);

			var inspector = el(
				InspectorControls,
				null,
				el(
					PanelBody,
					{ title: __( 'Ad slot', 'promovolve' ) },
					el( TextControl, {
						label: __( 'Slot ID', 'promovolve' ),
						help: __( 'A stable name you choose — no pre-registration needed. Lowercase letters, numbers and dashes.', 'promovolve' ),
						value: a.slotId,
						onChange: function ( value ) {
							props.setAttributes( { slotId: sanitizeId( value ) } );
						},
						__next40pxDefaultSize: true,
						__nextHasNoMarginBottom: true
					} ),
					el( SelectControl, {
						label: __( 'Size', 'promovolve' ),
						value: sizeSelectValue( a.w, a.h ),
						options: SIZES.map( function ( s ) {
							return { label: s.label, value: s.w + 'x' + s.h };
						} ).concat( [ { label: __( 'Custom…', 'promovolve' ), value: 'custom' } ] ),
						onChange: function ( value ) {
							if ( 'custom' === value ) {
								return;
							}
							var parts = value.split( 'x' );
							props.setAttributes( { w: parseInt( parts[ 0 ], 10 ), h: parseInt( parts[ 1 ], 10 ) } );
						},
						__next40pxDefaultSize: true,
						__nextHasNoMarginBottom: true
					} ),
					el(
						'div',
						{ style: { display: 'flex', gap: '8px' } },
						el( TextControl, {
							label: __( 'Width', 'promovolve' ),
							type: 'number',
							min: 1,
							value: a.w,
							onChange: function ( value ) {
								props.setAttributes( { w: Math.max( 1, parseInt( value, 10 ) || 0 ) } );
							},
							__next40pxDefaultSize: true,
							__nextHasNoMarginBottom: true
						} ),
						el( TextControl, {
							label: __( 'Height', 'promovolve' ),
							type: 'number',
							min: 1,
							value: a.h,
							onChange: function ( value ) {
								props.setAttributes( { h: Math.max( 1, parseInt( value, 10 ) || 0 ) } );
							},
							__next40pxDefaultSize: true,
							__nextHasNoMarginBottom: true
						} )
					),
					el( SelectControl, {
						label: __( 'Slot identity', 'promovolve' ),
						value: scope,
						options: SCOPES.map( function ( s ) {
							return { label: s.label, value: s.value };
						} ),
						help: __( 'Each distinct ID is its own dashboard row, with its own floor learning and ad pool. Splitting per category keeps that list small and topical; per post gives exact attribution but one cold pool per post. Only takes effect on single posts and pages — elsewhere the shared ID is used.', 'promovolve' ),
						onChange: function ( value ) {
							props.setAttributes( { scope: value } );
						},
						__next40pxDefaultSize: true,
						__nextHasNoMarginBottom: true
					} ),
					el(
						'p',
						{ style: { marginTop: '12px', color: '#50575e', fontSize: '12px' } },
						! valid
							? __( 'A slot needs an ID and a positive width and height — otherwise it renders nothing.', 'promovolve' )
							: sprintf(
								/* translators: %s: the effective slot ID */
								__( 'Dashboard slot ID: %s — the size is part of the identity, so changing it starts a fresh slot with its own stats.', 'promovolve' ),
								displayId
							)
					),
					duplicate
						? el(
							Notice,
							{ status: 'warning', isDismissible: false },
							__( 'Another slot on this page uses the same ID. Only the first one fills — give this slot a different ID or size.', 'promovolve' )
						)
						: null,
					config.configured === false && config.settingsUrl
						? el(
							Notice,
							{ status: 'warning', isDismissible: false },
							el(
								Fragment,
								null,
								__( 'This site is not connected to an ad server yet, so slots stay empty. ', 'promovolve' ),
								el( ExternalLink, { href: config.settingsUrl }, __( 'Open Promovolve settings', 'promovolve' ) )
							)
						)
						: null
				)
			);

			return el( Fragment, null, inspector, el( 'div', blockProps, placeholder ) );
		},

		// Dynamic block: PHP owns the front-end markup.
		save: function () {
			return null;
		}
	} );
} )( window.wp );
