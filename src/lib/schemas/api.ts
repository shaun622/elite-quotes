import { z } from 'zod';
import { QuoteDataSchema } from './quote';

export const PutQuoteBodySchema = z.object({
	data: QuoteDataSchema
});

export type PutQuoteBody = z.infer<typeof PutQuoteBodySchema>;

export const PutQuoteResponseSchema = z.object({
	dataHash: z.string(),
	versionNumber: z.number().int()
});

export const GetQuoteResponseSchema = z.object({
	data: QuoteDataSchema,
	dataHash: z.string(),
	versionNumber: z.number().int()
});

export const ConflictResponseSchema = z.object({
	error: z.literal('conflict'),
	currentDataHash: z.string(),
	currentVersion: z.number().int()
});
