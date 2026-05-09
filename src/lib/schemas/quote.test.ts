import { describe, it, expect } from 'vitest';
import { QuoteDataSchema, emptyQuote, type QuoteData } from './quote';
import { PutQuoteBodySchema } from './api';

describe('QuoteDataSchema', () => {
	it('produces a valid empty quote with schemaVersion 1', () => {
		const q = emptyQuote();
		expect(q.schemaVersion).toBe(1);
		expect(q.client.name).toBe('');
		expect(q.client.email).toBe('');
		expect(q.site.address).toBe('');
		expect(q.walls).toEqual([]);
		expect(q.materials.blockType).toBe('');
		expect(q.pricing.subtotalCents).toBe(0);
		expect(q.pricing.totalCents).toBe(0);
		expect(q.meta.flags.engineerCertRequired).toBe(false);
	});

	it('round-trips through JSON without information loss', () => {
		const q = emptyQuote();
		const cloned = QuoteDataSchema.parse(JSON.parse(JSON.stringify(q)));
		expect(cloned).toEqual(q);
	});

	it('rejects an invalid email in the client block', () => {
		const result = QuoteDataSchema.safeParse({
			schemaVersion: 1,
			client: { name: '', email: 'not-an-email', phone: '', notes: '' },
			site: {},
			walls: [],
			materials: {},
			pricing: {},
			meta: {}
		});
		expect(result.success).toBe(false);
	});

	it('accepts an empty string in the email field (default for new draft)', () => {
		const result = QuoteDataSchema.safeParse({
			schemaVersion: 1,
			client: { name: '', email: '', phone: '', notes: '' }
		});
		expect(result.success).toBe(true);
	});

	it('rejects a wrong schemaVersion', () => {
		const result = QuoteDataSchema.safeParse({ schemaVersion: 2 });
		expect(result.success).toBe(false);
	});

	it('keeps post spacing default at 2400 mm and panel module at 200 mm', () => {
		const q: QuoteData = QuoteDataSchema.parse({
			walls: [{ id: 'w1', name: 'Wall 1' }]
		});
		expect(q.walls[0].defaults.postSpacingMm).toBe(2400);
		expect(q.walls[0].defaults.panelModuleMm).toBe(200);
		expect(q.walls[0].defaults.boundaryOffsetMm).toBe(100);
		expect(q.walls[0].defaults.concreteStrength).toBe('N25');
	});

	it('rejects an invalid Australian postcode shape', () => {
		const result = QuoteDataSchema.safeParse({
			site: { postcode: '40' }
		});
		expect(result.success).toBe(false);
	});
});

describe('PutQuoteBodySchema', () => {
	it('wraps a valid quote body', () => {
		const result = PutQuoteBodySchema.safeParse({ data: emptyQuote() });
		expect(result.success).toBe(true);
	});

	it('rejects a body missing the data envelope', () => {
		const result = PutQuoteBodySchema.safeParse({ schemaVersion: 1 });
		expect(result.success).toBe(false);
	});
});
