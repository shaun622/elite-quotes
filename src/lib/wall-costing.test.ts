import { describe, it, expect } from 'vitest';
import { QuoteDataSchema } from './schemas/quote';
import {
	retainingRateCents,
	topperRateCents,
	wallCost,
	jobTotals,
	isManualWall,
	formatCents
} from './wall-costing';

const card = QuoteDataSchema.parse({}).rateCard;

/** Straight wall ~given metres long via a manual length (no geometry needed
 *  for the costing maths — manual + drawn share the same rate functions). */
function manualWall(opts: {
	lengthM: number;
	heightMm: number;
	topperType?: string;
	id?: string;
}) {
	return QuoteDataSchema.parse({
		walls: [
			{
				id: opts.id ?? 'w1',
				name: 'Wall 1',
				manualLengthM: opts.lengthM,
				manualHeightMm: opts.heightMm,
				build: { topperType: opts.topperType ?? 'none' }
			}
		]
	}).walls[0];
}

describe('retainingRateCents', () => {
	it('picks the band containing the height', () => {
		expect(retainingRateCents(card, 400)).toBe(30000); // ≤600
		expect(retainingRateCents(card, 600)).toBe(30000); // inclusive upper bound
		expect(retainingRateCents(card, 900)).toBe(45000); // ≤1000
		expect(retainingRateCents(card, 1300)).toBe(60000); // ≤1400
	});
	it('falls through to the tallest band above the top bound', () => {
		expect(retainingRateCents(card, 9000)).toBe(105000);
	});
});

describe('topperRateCents', () => {
	it('returns 0 for none', () => {
		expect(topperRateCents(card, 'none')).toBe(0);
	});
	it('returns the colorbond rate', () => {
		expect(topperRateCents(card, 'colorbond')).toBe(20000);
	});
	it('falls back to other for unknown types', () => {
		expect(topperRateCents(card, 'mystery')).toBe(card.topperPerMetreCents.other);
	});
});

describe('wallCost', () => {
	it('prices a retaining-only manual wall by length × band rate', () => {
		const w = manualWall({ lengthM: 35, heightMm: 400 });
		const c = wallCost(w, card);
		// 35 m × $300/m = $10,500
		expect(c.retainingCents).toBe(1_050_000);
		expect(c.topperCents).toBe(0);
		expect(c.totalCents).toBe(1_050_000);
		expect(c.lengthM).toBe(35);
		expect(c.m2).toBeCloseTo(35 * 0.4, 5);
	});

	it('adds a topper line running the full wall length', () => {
		const w = manualWall({ lengthM: 35, heightMm: 400, topperType: 'colorbond' });
		const c = wallCost(w, card);
		// retaining $10,500 + colorbond 35 × $200 = $7,000 → $17,500
		expect(c.retainingCents).toBe(1_050_000);
		expect(c.topperLengthM).toBe(35);
		expect(c.topperCents).toBe(700_000);
		expect(c.totalCents).toBe(1_750_000);
	});

	it('flags a wall with no geometry as manual', () => {
		const w = manualWall({ lengthM: 12, heightMm: 600 });
		expect(isManualWall(w)).toBe(true);
	});
});

describe('jobTotals', () => {
	it('sums cost + measurements across walls', () => {
		const a = manualWall({ lengthM: 35, heightMm: 400, topperType: 'colorbond', id: 'a' });
		const b = manualWall({ lengthM: 15, heightMm: 200, id: 'b' });
		const totals = jobTotals([a, b], card);
		expect(totals.lengthM).toBe(50);
		// a: 10,500 + 7,000 = 17,500 ; b: 15 × $300 = 4,500
		expect(totals.retainingCents).toBe(1_050_000 + 450_000);
		expect(totals.topperCents).toBe(700_000);
		expect(totals.totalCents).toBe(1_050_000 + 450_000 + 700_000);
		expect(totals.perWall).toHaveLength(2);
	});
});

describe('formatCents', () => {
	it('formats cents as AUD', () => {
		expect(formatCents(1_750_000)).toBe('$17,500.00');
		expect(formatCents(2_543_20)).toBe('$2,543.20');
	});
});
