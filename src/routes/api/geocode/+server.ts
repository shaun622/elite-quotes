import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { parseMapboxFeature, type MapboxFeature } from '$lib/mapbox';

/**
 * Server-proxied address autocomplete via Mapbox Geocoding v5.
 *
 *   GET /api/geocode?q=12+Smith+St
 *   → { suggestions: [{ label, lat, lng, state, postcode }, ...] }
 *
 * Auth-required so it's not abusable as an open geocoder. Biased toward
 * Brisbane (Elite Walls' base) but constrained to Australia.
 */

const BRISBANE_PROXIMITY = '153.0260,-27.4698';

export const GET: RequestHandler = async ({ url, locals, platform }) => {
	if (!locals.user || !locals.org) error(401, 'Authentication required');
	if (!platform?.env) error(500, 'Cloudflare bindings unavailable');

	const token = (platform.env.MAPBOX_TOKEN ?? '').trim();
	if (!token) error(500, 'Mapbox token not configured');

	const q = url.searchParams.get('q')?.trim() ?? '';
	if (q.length < 3) return json({ suggestions: [] });

	const params = new URLSearchParams({
		access_token: token,
		country: 'au',
		autocomplete: 'true',
		limit: '5',
		types: 'address,place,locality,postcode',
		proximity: BRISBANE_PROXIMITY
	});

	const upstream = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?${params}`;
	const res = await fetch(upstream, {
		// Edge-cache for 60s — same query within a minute is free.
		cf: { cacheTtl: 60, cacheEverything: true }
	} as RequestInit);

	if (!res.ok) {
		error(502, `Mapbox geocoding ${res.status}`);
	}

	const data = (await res.json()) as { features?: MapboxFeature[] };
	const suggestions = (data.features ?? []).map(parseMapboxFeature);

	return json(
		{ suggestions },
		{ headers: { 'Cache-Control': 'private, max-age=60' } }
	);
};
