import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchParcel } from '$lib/server/cadastre';

/**
 * Server-proxied property-boundary lookup.
 *
 *   GET /api/cadastre?state=QLD&lat=-27.4698&lng=153.0260
 *   → { boundary: { type: 'Polygon', coordinates: [...] } | null }
 *
 * Auth-required. The result is meant to be cached by the caller into
 * `data.site.propertyBoundaryGeoJson` so we hit the upstream once per quote.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user || !locals.org) error(401, 'Authentication required');

	const lat = Number(url.searchParams.get('lat'));
	const lng = Number(url.searchParams.get('lng'));
	const state = url.searchParams.get('state');

	if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
		error(400, 'lat and lng query parameters are required');
	}

	try {
		const boundary = await fetchParcel({ state, lng, lat });
		return json({ boundary }, { headers: { 'Cache-Control': 'private, max-age=3600' } });
	} catch {
		// Upstream failure shouldn't break Step 2 — surface null so the UI falls
		// back to "no boundary, eyeball the satellite".
		return json({ boundary: null });
	}
};
