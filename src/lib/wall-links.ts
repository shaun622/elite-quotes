/**
 * Cross-wall endpoint link detection.
 *
 * When two walls' geometric endpoints sit within ~0.3 m of each other (a
 * typical corner / return-wall scenario), they're considered linked and
 * the elevation editor surfaces a "Match neighbour" affordance so the NGL
 * value can be copied across the join.
 *
 * Links are computed at render-time from existing geometry — no schema
 * change is needed and no link metadata is stored.
 */

import { haversineMeters, pathToSegments, type LngLat } from './wall-math';
import type { QuoteData } from './schemas/quote';

const LINK_THRESHOLD_M = 0.3;

export type WallEndpointAnchor = {
	wallId: string;
	wallName: string;
	end: 'start' | 'end';
	postIdx: number; // 0 if start, lastPostIdx if end
	lngLat: LngLat;
};

export type WallEndpointLink = {
	a: WallEndpointAnchor;
	b: WallEndpointAnchor;
	distanceM: number;
};

/** Returns the start and end coordinates of a wall, treating its
 *  multi-segment path as one logical run from the first vertex of the
 *  first sub-segment to the last vertex of the last sub-segment. */
export function wallStartAndEnd(wall: QuoteData['walls'][number]): {
	start: LngLat | null;
	end: LngLat | null;
	postCount: number;
} {
	const segs = pathToSegments(wall.pathGeoJson ?? null);
	if (segs.length === 0) return { start: null, end: null, postCount: 0 };
	const firstSeg = segs[0];
	const lastSeg = segs[segs.length - 1];
	const start = firstSeg[0] ?? null;
	const end = lastSeg[lastSeg.length - 1] ?? null;
	return { start, end, postCount: wall.posts.length };
}

/** All endpoint anchors across all walls — used to build the link list. */
export function wallAnchors(walls: QuoteData['walls']): WallEndpointAnchor[] {
	const anchors: WallEndpointAnchor[] = [];
	for (const w of walls) {
		const { start, end, postCount } = wallStartAndEnd(w);
		if (start) {
			anchors.push({
				wallId: w.id,
				wallName: w.name,
				end: 'start',
				postIdx: 0,
				lngLat: start
			});
		}
		if (end) {
			anchors.push({
				wallId: w.id,
				wallName: w.name,
				end: 'end',
				postIdx: Math.max(0, postCount - 1),
				lngLat: end
			});
		}
	}
	return anchors;
}

/** Pairwise endpoint links across distinct walls within LINK_THRESHOLD_M. */
export function findWallEndpointLinks(walls: QuoteData['walls']): WallEndpointLink[] {
	const anchors = wallAnchors(walls);
	const links: WallEndpointLink[] = [];
	for (let i = 0; i < anchors.length; i++) {
		for (let j = i + 1; j < anchors.length; j++) {
			const a = anchors[i];
			const b = anchors[j];
			if (a.wallId === b.wallId) continue;
			const d = haversineMeters(a.lngLat, b.lngLat);
			if (d <= LINK_THRESHOLD_M) {
				links.push({ a, b, distanceM: d });
			}
		}
	}
	return links;
}

/**
 * For a given (wallId, postIdx), find the linked anchor on another wall.
 * Returns null if no link, or the anchor on the OTHER wall if found.
 */
export function findLinkForPost(opts: {
	walls: QuoteData['walls'];
	wallId: string;
	postIdx: number;
}): WallEndpointAnchor | null {
	const { walls, wallId, postIdx } = opts;
	const wall = walls.find((w) => w.id === wallId);
	if (!wall) return null;
	const isStart = postIdx === 0;
	const isEnd = postIdx === wall.posts.length - 1 && wall.posts.length > 0;
	if (!isStart && !isEnd) return null;
	const links = findWallEndpointLinks(walls);
	for (const link of links) {
		if (link.a.wallId === wallId && (isStart ? link.a.end === 'start' : link.a.end === 'end')) {
			return link.b;
		}
		if (link.b.wallId === wallId && (isStart ? link.b.end === 'start' : link.b.end === 'end')) {
			return link.a;
		}
	}
	return null;
}
