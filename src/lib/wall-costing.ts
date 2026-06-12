/**
 * Live cost estimate for the running total shown while drawing on Step 2.
 *
 * Retaining is priced by $/lineal-metre chosen from each section's AVERAGE
 * retained height (taller → pricier band). Toppers (Colorbond / fence) are a
 * flat $/lineal-metre by type, running the full wall length. Manual-mode walls
 * (no drawn geometry) use their typed length + height instead of sections.
 *
 * This is an ESTIMATE to guide on-site quoting, not a binding schedule — the
 * estimator refines the final number on the Pricing step.
 */

import type { QuoteData, RateCard } from '$lib/schemas/quote';
import {
	multiPolylineLengthMeters,
	pathToSegments,
	polylineLengthMeters
} from '$lib/wall-math';
import { sectionStartEndMm } from '$lib/wall-heights';

type Wall = QuoteData['walls'][number];

/** Length used for costing: drawn geometry if present, else the typed manual
 *  length, else 0. */
export function effectiveWallLengthM(wall: Wall): number {
	const geom = multiPolylineLengthMeters(pathToSegments(wall.pathGeoJson ?? null));
	if (geom > 0.001) return geom;
	return wall.manualLengthM ?? 0;
}

/** True when the wall is measured by typed length rather than drawn geometry. */
export function isManualWall(wall: Wall): boolean {
	return multiPolylineLengthMeters(pathToSegments(wall.pathGeoJson ?? null)) <= 0.001;
}

/** Retaining $/m (cents) for a given retained height, from the rate card's
 *  height bands. Falls through to the tallest band above the top bound. */
export function retainingRateCents(card: RateCard, heightMm: number): number {
	const bands = [...card.retainingBands].sort((a, b) => a.maxHeightMm - b.maxHeightMm);
	for (const b of bands) if (heightMm <= b.maxHeightMm) return b.perMetreCents;
	return bands.length ? bands[bands.length - 1].perMetreCents : 0;
}

/** Topper $/m (cents) by type. 'none' is never priced. */
export function topperRateCents(card: RateCard, type: string): number {
	if (type === 'none') return 0;
	return card.topperPerMetreCents[type] ?? card.topperPerMetreCents.other ?? 0;
}

export interface WallCost {
	lengthM: number;
	retainingCents: number;
	topperLengthM: number;
	topperCents: number;
	totalCents: number;
	/** Retaining wall face area (m²) = Σ length × avg height. */
	m2: number;
}

/** Cost breakdown for a single wall. */
export function wallCost(wall: Wall, card: RateCard): WallCost {
	const segs = pathToSegments(wall.pathGeoJson ?? null);
	const geomLen = multiPolylineLengthMeters(segs);
	let retainingCents = 0;
	let m2 = 0;

	if (geomLen > 0.001) {
		// Drawn — price each section by its own average height.
		segs.forEach((seg, i) => {
			const len = polylineLengthMeters(seg);
			const { startMm, endMm } = sectionStartEndMm(wall, i);
			const avgMm = (startMm + endMm) / 2;
			retainingCents += Math.round(len * retainingRateCents(card, avgMm));
			m2 += len * (avgMm / 1000);
		});
	} else {
		// Manual — one length × one height.
		const len = wall.manualLengthM ?? 0;
		const h = wall.manualHeightMm ?? wall.defaults.defaultHeightMm ?? 0;
		retainingCents = Math.round(len * retainingRateCents(card, h));
		m2 = len * (h / 1000);
	}

	const lengthM = effectiveWallLengthM(wall);
	const topperOn = wall.build.topperType !== 'none';
	const topperLengthM = topperOn ? lengthM : 0;
	const topperCents = topperOn
		? Math.round(topperLengthM * topperRateCents(card, wall.build.topperType))
		: 0;

	return {
		lengthM,
		retainingCents,
		topperLengthM,
		topperCents,
		totalCents: retainingCents + topperCents,
		m2
	};
}

export interface JobTotals {
	perWall: Array<{ id: string; name: string } & WallCost>;
	lengthM: number;
	retainingCents: number;
	topperLengthM: number;
	topperCents: number;
	m2: number;
	totalCents: number;
}

/** Aggregate cost + measurement totals across all walls. */
export function jobTotals(walls: Wall[], card: RateCard): JobTotals {
	let lengthM = 0;
	let retainingCents = 0;
	let topperLengthM = 0;
	let topperCents = 0;
	let m2 = 0;
	const perWall = walls.map((w) => {
		const c = wallCost(w, card);
		lengthM += c.lengthM;
		retainingCents += c.retainingCents;
		topperLengthM += c.topperLengthM;
		topperCents += c.topperCents;
		m2 += c.m2;
		return { id: w.id, name: w.name, ...c };
	});
	return {
		perWall,
		lengthM,
		retainingCents,
		topperLengthM,
		topperCents,
		m2,
		totalCents: retainingCents + topperCents
	};
}

/** cents → "$1,234.56" */
export function formatCents(cents: number): string {
	return `$${(cents / 100).toLocaleString('en-AU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})}`;
}
