import { fetchQldParcel } from './qld';
import { fetchNswParcel } from './nsw';
import type { PolygonBoundary } from './types';

export type { PolygonBoundary };

/**
 * Dispatches to the right state cadastre adapter. Returns null if the state
 * has no adapter wired (VIC/SA/WA/TAS/ACT/NT today — add as needed).
 */
export async function fetchParcel(opts: {
	state: string | null | undefined;
	lng: number;
	lat: number;
}): Promise<PolygonBoundary | null> {
	const state = opts.state?.toUpperCase();
	switch (state) {
		case 'QLD':
			return fetchQldParcel(opts.lng, opts.lat);
		case 'NSW':
			return fetchNswParcel(opts.lng, opts.lat);
		default:
			return null;
	}
}
