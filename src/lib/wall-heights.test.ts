import { describe, it, expect } from 'vitest';
import { retainedAtDistance, sectionStartEndMm } from './wall-heights';
import { QuoteDataSchema } from './schemas/quote';

/**
 * Helper: build a fixture wall with a single straight section of known
 * geometric length (~10 m) by placing two coordinates a known number of
 * degrees apart. At lat 0 the metres-per-deg-of-longitude is the equatorial
 * value, so picking lng offsets in degrees from haversine output keeps the
 * tests independent of magic numbers.
 */
function fixtureWall(opts: {
	startMm: number | null;
	endMm: number | null;
	defaultHeightMm?: number;
	lengthDeg?: number;
}) {
	const len = opts.lengthDeg ?? 0.0001; // ~11.1 m at equator
	return QuoteDataSchema.parse({
		walls: [
			{
				id: 'w1',
				name: 'Wall 1',
				pathGeoJson: {
					type: 'MultiLineString',
					coordinates: [
						[
							[0, 0],
							[len, 0]
						]
					]
				},
				sectionHeights: [{ startMm: opts.startMm, endMm: opts.endMm }],
				defaults: {
					defaultHeightMm: opts.defaultHeightMm ?? 600,
					boundaryOffsetMm: 300,
					panelModuleMm: 200,
					postSpacingMm: 2400,
					concreteStrength: 'N25' as const
				}
			}
		]
	}).walls[0];
}

describe('sectionStartEndMm', () => {
	it('returns the explicit start/end when both are set', () => {
		const w = fixtureWall({ startMm: 600, endMm: 1200 });
		expect(sectionStartEndMm(w, 0)).toEqual({ startMm: 600, endMm: 1200 });
	});

	it('falls back to the wall default when both are null', () => {
		const w = fixtureWall({ startMm: null, endMm: null, defaultHeightMm: 750 });
		expect(sectionStartEndMm(w, 0)).toEqual({ startMm: 750, endMm: 750 });
	});

	it('falls back per-field when one is null', () => {
		const w = fixtureWall({ startMm: 800, endMm: null, defaultHeightMm: 500 });
		expect(sectionStartEndMm(w, 0)).toEqual({ startMm: 800, endMm: 500 });
	});
});

describe('retainedAtDistance', () => {
	it('returns the start height at distance 0', () => {
		const w = fixtureWall({ startMm: 600, endMm: 1200 });
		expect(retainedAtDistance(w, 0)).toBe(600);
	});

	it('returns the end height at the full wall length', () => {
		const w = fixtureWall({ startMm: 600, endMm: 1200 });
		// 0.0001 deg ≈ 11.13 m near the equator; pick a distance well past the end.
		expect(retainedAtDistance(w, 100)).toBe(1200);
	});

	it('linearly interpolates between start and end at the midpoint', () => {
		const w = fixtureWall({ startMm: 600, endMm: 1200 });
		// True midpoint distance — fetched via the same helper that the
		// production code uses so we don't second-guess earth-radius constants.
		const fullLen = retainedAtDistance(w, 1e9); // way past end, returns end
		expect(fullLen).toBe(1200);
		// Approximate midpoint at ~5.5 m for our 0.0001-deg fixture.
		const mid = retainedAtDistance(w, 5.566);
		expect(mid).toBeGreaterThan(890);
		expect(mid).toBeLessThan(910);
	});

	it('clamps negative distances to the start height', () => {
		const w = fixtureWall({ startMm: 700, endMm: 1500 });
		expect(retainedAtDistance(w, -3)).toBe(700);
	});

	it('returns the wall default when the path has no segments', () => {
		const w = QuoteDataSchema.parse({
			walls: [{ id: 'w1', name: 'Empty', defaults: { defaultHeightMm: 800 } }]
		}).walls[0];
		expect(retainedAtDistance(w, 5)).toBe(800);
	});
});
