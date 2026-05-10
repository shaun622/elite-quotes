/**
 * Generic ArcGIS REST cadastre query.
 *
 * The state-level cadastre services Australia publishes are all ArcGIS REST
 * MapServer/FeatureServer instances with a `/query` endpoint that takes a
 * point geometry and returns the intersecting parcel polygon as GeoJSON.
 *
 * State-specific URLs may change over time — when they do, swap in
 * `cadastre/qld.ts` etc. and the rest of the system carries on.
 */

import type { PolygonBoundary } from './types';

export async function fetchArcgisParcelPolygon(opts: {
	queryUrl: string;
	lng: number;
	lat: number;
}): Promise<PolygonBoundary | null> {
	const params = new URLSearchParams({
		f: 'geojson',
		geometry: `${opts.lng},${opts.lat}`,
		geometryType: 'esriGeometryPoint',
		spatialRel: 'esriSpatialRelIntersects',
		inSR: '4326',
		outSR: '4326',
		outFields: '*',
		returnGeometry: 'true'
	});

	const url = `${opts.queryUrl}/query?${params}`;
	const res = await fetch(url, {
		// Edge-cache for 24h — cadastre changes are infrequent and a stale
		// boundary just means the user sees the previous shape.
		cf: { cacheTtl: 86_400, cacheEverything: true }
	} as RequestInit);

	if (!res.ok) return null;

	const data = (await res.json()) as {
		features?: Array<{
			geometry?:
				| { type: 'Polygon'; coordinates: number[][][] }
				| { type: 'MultiPolygon'; coordinates: number[][][][] };
		}>;
	};

	const feature = data.features?.[0];
	if (!feature?.geometry) return null;

	if (feature.geometry.type === 'Polygon') {
		return {
			type: 'Polygon',
			coordinates: normaliseRings(feature.geometry.coordinates)
		};
	}
	if (feature.geometry.type === 'MultiPolygon') {
		// Use the largest polygon — simplest sensible choice.
		const polys = feature.geometry.coordinates;
		let best: number[][][] = polys[0];
		for (const poly of polys) {
			if (ringArea(poly[0]) > ringArea(best[0])) best = poly;
		}
		return { type: 'Polygon', coordinates: normaliseRings(best) };
	}
	return null;
}

function normaliseRings(rings: number[][][]): [number, number][][] {
	return rings.map(
		(ring) =>
			ring.map((p) => [Number(p[0]), Number(p[1])] as [number, number]) satisfies [
				number,
				number
			][]
	);
}

function ringArea(ring: number[][]): number {
	// Shoelace; sign doesn't matter for size comparison.
	let s = 0;
	for (let i = 0; i < ring.length - 1; i++) {
		s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
	}
	return Math.abs(s);
}
