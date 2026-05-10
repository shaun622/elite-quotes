/**
 * Geometry helpers for wall drawing — runs in both browser and worker.
 *
 * Coordinates are GeoJSON-style [lng, lat] tuples in WGS84 throughout.
 * Distances are computed via the haversine formula on the WGS84 sphere; for
 * the segment lengths we deal with (a few metres to a few hundred metres on
 * a single property), the error vs. true geodesic is negligible.
 */

export type LngLat = [number, number];

const EARTH_RADIUS_M = 6_371_008.8; // mean Earth radius per WGS84

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance between two [lng, lat] points, in metres. */
export function haversineMeters(a: LngLat, b: LngLat): number {
	const φ1 = toRad(a[1]);
	const φ2 = toRad(b[1]);
	const Δφ = toRad(b[1] - a[1]);
	const Δλ = toRad(b[0] - a[0]);
	const x =
		Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** Sum of segment distances along a polyline in metres. */
export function polylineLengthMeters(coords: LngLat[]): number {
	let total = 0;
	for (let i = 1; i < coords.length; i++) {
		total += haversineMeters(coords[i - 1], coords[i]);
	}
	return total;
}

/** Sum of polyline lengths across an array of disconnected sub-segments. */
export function multiPolylineLengthMeters(segments: LngLat[][]): number {
	let total = 0;
	for (const seg of segments) total += polylineLengthMeters(seg);
	return total;
}

/**
 * Normalise a stored path (LineString | MultiLineString | null) into a flat
 * array-of-segments shape that the drawing UI works with throughout.
 */
type StoredPath =
	| { type: 'LineString'; coordinates: [number, number][] }
	| { type: 'MultiLineString'; coordinates: [number, number][][] }
	| null
	| undefined;

export function pathToSegments(path: StoredPath): LngLat[][] {
	if (!path) return [];
	if (path.type === 'LineString') {
		return path.coordinates.length > 0 ? [path.coordinates.slice() as LngLat[]] : [];
	}
	return path.coordinates.map((seg) => seg.slice() as LngLat[]);
}

/**
 * Convert segments back to the canonical MultiLineString storage shape.
 * Drops empty sub-segments. Returns null when there's nothing to store.
 */
export function segmentsToPath(
	segments: LngLat[][]
): { type: 'MultiLineString'; coordinates: [number, number][][] } | null {
	const cleaned = segments.filter((seg) => seg.length > 0);
	if (cleaned.length === 0) return null;
	return { type: 'MultiLineString', coordinates: cleaned };
}

/**
 * Local east/north metres-per-degree at a given latitude.
 * Good enough at property scale (<1 km extents).
 */
function metresPerDegree(lat: number): { mPerDegLng: number; mPerDegLat: number } {
	const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
	const mPerDegLng = mPerDegLat * Math.cos(toRad(lat));
	return { mPerDegLng, mPerDegLat };
}

/** Convert a [lng, lat] to local east/north metres relative to an origin. */
export function lngLatToLocal(p: LngLat, origin: LngLat): { x: number; y: number } {
	const { mPerDegLng, mPerDegLat } = metresPerDegree(origin[1]);
	return {
		x: (p[0] - origin[0]) * mPerDegLng,
		y: (p[1] - origin[1]) * mPerDegLat
	};
}

/** Inverse of `lngLatToLocal`. */
export function localToLngLat(p: { x: number; y: number }, origin: LngLat): LngLat {
	const { mPerDegLng, mPerDegLat } = metresPerDegree(origin[1]);
	return [origin[0] + p.x / mPerDegLng, origin[1] + p.y / mPerDegLat];
}

/** Bearing from a → b in radians, measured east-of-north. */
export function bearingRad(a: LngLat, b: LngLat): number {
	const local = lngLatToLocal(b, a);
	return Math.atan2(local.x, local.y);
}

/**
 * Snap candidate point so the new segment (a→b→snapped) is at exactly 0°,
 * 90°, 180° or 270° relative to the prior segment, when within toleranceDeg.
 *
 * Returns either the snapped LngLat or null if the candidate isn't within
 * the snap tolerance of any axis.
 */
export function snapAngle(opts: {
	prev: LngLat;
	pivot: LngLat;
	candidate: LngLat;
	toleranceDeg?: number;
}): { snapped: LngLat; angleDeg: 0 | 90 | 180 | 270 } | null {
	const tolerance = opts.toleranceDeg ?? 6;
	const inBearing = bearingRad(opts.prev, opts.pivot);
	const candBearing = bearingRad(opts.pivot, opts.candidate);
	const relRad = candBearing - inBearing;
	let relDeg = ((toDeg(relRad) % 360) + 360) % 360;

	for (const target of [0, 90, 180, 270] as const) {
		const diff = Math.min(Math.abs(relDeg - target), Math.abs(relDeg - target - 360));
		if (diff <= tolerance) {
			// Compute distance and new direction.
			const dist = haversineMeters(opts.pivot, opts.candidate);
			const newBearingRad = inBearing + toRad(target);
			const local = {
				x: dist * Math.sin(newBearingRad),
				y: dist * Math.cos(newBearingRad)
			};
			return { snapped: localToLngLat(local, opts.pivot), angleDeg: target };
		}
	}
	return null;
}

/**
 * Offset a polyline by `offsetMeters` perpendicular to its direction of travel.
 * Positive offset is to the LEFT of travel (north when heading east), negative
 * is to the right. Uses local cartesian projection — fine for property scale.
 *
 * Vertex-by-vertex: each interior vertex offsets by the average of its two
 * adjacent segment normals; endpoints offset by the single adjacent normal.
 */
export function offsetPolyline(coords: LngLat[], offsetMeters: number): LngLat[] {
	if (coords.length < 2 || offsetMeters === 0) return coords.slice();

	const origin = coords[0];
	const local = coords.map((c) => lngLatToLocal(c, origin));

	// Per-segment normals (perpendicular, length = offsetMeters)
	const segNorm = new Array<{ x: number; y: number }>(local.length - 1);
	for (let i = 0; i < local.length - 1; i++) {
		const dx = local[i + 1].x - local[i].x;
		const dy = local[i + 1].y - local[i].y;
		const len = Math.hypot(dx, dy) || 1;
		// Left-hand normal: (-dy, dx) / len
		segNorm[i] = { x: (-dy / len) * offsetMeters, y: (dx / len) * offsetMeters };
	}

	const offsetLocal = local.map((p, i) => {
		const before = i === 0 ? segNorm[0] : segNorm[i - 1];
		const after = i === local.length - 1 ? segNorm[segNorm.length - 1] : segNorm[i];
		return { x: p.x + (before.x + after.x) / 2, y: p.y + (before.y + after.y) / 2 };
	});

	return offsetLocal.map((p) => localToLngLat(p, origin));
}

/**
 * Distance from a point to a line segment, in metres. Used to find which
 * segment the user clicked on for vertex insertion, and to know how close
 * a click is to an existing line.
 */
export function pointToSegmentMeters(p: LngLat, a: LngLat, b: LngLat): number {
	const origin = a;
	const lp = lngLatToLocal(p, origin);
	const la = { x: 0, y: 0 };
	const lb = lngLatToLocal(b, origin);
	const dx = lb.x - la.x;
	const dy = lb.y - la.y;
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(lp.x, lp.y);
	let t = ((lp.x - la.x) * dx + (lp.y - la.y) * dy) / lenSq;
	t = Math.max(0, Math.min(1, t));
	const projX = la.x + t * dx;
	const projY = la.y + t * dy;
	return Math.hypot(lp.x - projX, lp.y - projY);
}

/**
 * Returns the index of the closest segment in `coords` to the point, plus
 * the distance in metres. Index `i` means the segment from coords[i] to
 * coords[i+1].
 */
export function nearestSegment(
	p: LngLat,
	coords: LngLat[]
): { index: number; distanceM: number } | null {
	if (coords.length < 2) return null;
	let bestIdx = 0;
	let bestDist = Infinity;
	for (let i = 0; i < coords.length - 1; i++) {
		const d = pointToSegmentMeters(p, coords[i], coords[i + 1]);
		if (d < bestDist) {
			bestDist = d;
			bestIdx = i;
		}
	}
	return { index: bestIdx, distanceM: bestDist };
}

/** Index of nearest vertex within thresholdMeters, or -1 if none. */
export function nearestVertex(
	p: LngLat,
	coords: LngLat[],
	thresholdMeters: number
): number {
	let bestIdx = -1;
	let bestDist = thresholdMeters;
	for (let i = 0; i < coords.length; i++) {
		const d = haversineMeters(p, coords[i]);
		if (d < bestDist) {
			bestDist = d;
			bestIdx = i;
		}
	}
	return bestIdx;
}
