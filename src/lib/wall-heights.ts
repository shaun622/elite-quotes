/**
 * Bridge between Step 2's section start/end retained heights and Step 3's
 * per-post RGL. The estimator enters heights at section boundaries in Step 2;
 * Step 3 then generates posts along the wall at the wall's post spacing and
 * each post needs an RGL value to sit at.
 *
 * `retainedAtDistance` walks the wall's sub-segments in order, accumulates
 * length, and linearly interpolates between `sectionHeights[i].startMm` and
 * `sectionHeights[i].endMm` for the section that contains the given distance.
 */

import type { QuoteData } from '$lib/schemas/quote';
import { pathToSegments, polylineLengthMeters } from '$lib/wall-math';

type Wall = QuoteData['walls'][number];

/**
 * Resolve start/end retained height (mm) for one section, falling through
 * the new chained `sectionHeights` → legacy `sectionHeightsMm` → wall default.
 *
 * Mirrors the equivalent fall-through in Step2Plan so Step 3 sees the same
 * values regardless of which generation of writer last touched the quote.
 */
export function sectionStartEndMm(
	wall: Wall,
	sectionIdx: number
): { startMm: number; endMm: number } {
	const newRow = wall.sectionHeights?.[sectionIdx];
	const legacy = wall.sectionHeightsMm?.[sectionIdx];
	const fallback = wall.defaults?.defaultHeightMm ?? 0;

	const startMm =
		typeof newRow?.startMm === 'number'
			? newRow.startMm
			: typeof legacy === 'number'
				? legacy
				: fallback;
	const endMm =
		typeof newRow?.endMm === 'number'
			? newRow.endMm
			: typeof legacy === 'number'
				? legacy
				: fallback;
	return { startMm, endMm };
}

/**
 * Retained-height (mm) at a given distance along the wall, in metres.
 *
 * Walks sections accumulating length. When `distanceM` falls inside section
 * i at fraction t of the section's length, returns
 * `lerp(start_i, end_i, t)`. Out-of-range distances clamp to the closest
 * endpoint.
 *
 * Returns `wall.defaults.defaultHeightMm` if the wall has no geometry yet.
 */
export function retainedAtDistance(wall: Wall, distanceM: number): number {
	const segs = pathToSegments(wall.pathGeoJson ?? null);
	const fallback = wall.defaults?.defaultHeightMm ?? 0;
	if (segs.length === 0) return fallback;

	// Clamp negative inputs to the very start of the wall.
	if (distanceM <= 0) {
		const { startMm } = sectionStartEndMm(wall, 0);
		return Math.round(startMm);
	}

	let cumulative = 0;
	for (let i = 0; i < segs.length; i++) {
		const seg = segs[i];
		const segLen = polylineLengthMeters(seg);
		if (segLen <= 0) continue;
		const isLast = i === segs.length - 1;
		if (distanceM <= cumulative + segLen || isLast) {
			const t = Math.max(0, Math.min(1, (distanceM - cumulative) / segLen));
			const { startMm, endMm } = sectionStartEndMm(wall, i);
			return Math.round(startMm + (endMm - startMm) * t);
		}
		cumulative += segLen;
	}
	return fallback;
}
