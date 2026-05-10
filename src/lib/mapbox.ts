/**
 * Mapbox helpers — Geocoding + Static Images API.
 *
 * The geocoding endpoint is server-proxied (`/api/geocode`) so the token
 * isn't sent on every keystroke. The static map URL embeds the token
 * directly because that's the only way Mapbox's Static Images API works,
 * and `pk.` tokens are designed to be public — restrict by URL in the
 * Mapbox dashboard for production hardening.
 */

export type GeocodeSuggestion = {
	label: string;
	lat: number;
	lng: number;
	state: AustralianState | null;
	postcode: string;
};

export const AUSTRALIAN_STATES = ['QLD', 'NSW', 'VIC', 'SA', 'WA', 'TAS', 'ACT', 'NT'] as const;
export type AustralianState = (typeof AUSTRALIAN_STATES)[number];

export type MapboxFeature = {
	place_name: string;
	center: [number, number];
	context?: Array<{ id: string; short_code?: string; text: string }>;
};

export function parseMapboxFeature(f: MapboxFeature): GeocodeSuggestion {
	let state: AustralianState | null = null;
	let postcode = '';
	for (const c of f.context ?? []) {
		if (c.id.startsWith('region')) {
			const code = c.short_code?.toUpperCase().replace('AU-', '');
			if (code && (AUSTRALIAN_STATES as readonly string[]).includes(code)) {
				state = code as AustralianState;
			}
		} else if (c.id.startsWith('postcode') && /^\d{4}$/.test(c.text)) {
			postcode = c.text;
		}
	}
	return {
		label: f.place_name,
		lng: f.center[0],
		lat: f.center[1],
		state,
		postcode
	};
}

export function staticMapUrl(opts: {
	token: string;
	lng: number;
	lat: number;
	zoom?: number;
	width?: number;
	height?: number;
	retina?: boolean;
}): string {
	const zoom = opts.zoom ?? 18;
	const w = opts.width ?? 600;
	const h = opts.height ?? 280;
	const r = opts.retina === false ? '' : '@2x';
	const pin = `pin-s+ff8a1c(${opts.lng},${opts.lat})`;
	return (
		`https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
		`${pin}/${opts.lng},${opts.lat},${zoom},0/${w}x${h}${r}` +
		`?access_token=${encodeURIComponent(opts.token)}&attribution=false&logo=false`
	);
}
