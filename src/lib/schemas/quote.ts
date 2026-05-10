import { z } from 'zod';

/**
 * Canonical shape of a quote's `data_json` column.
 *
 * Bump `schemaVersion` whenever the structure changes incompatibly. PDFs and
 * the takeoff API both derive from this shape — type drift here is a bug.
 *
 * Many fields are placeholders for follow-up PRs (map paths, post profiles,
 * pricing rates). They exist now so the JSON contract is stable across PRs.
 *
 * Inner-field `.default()`s mean inserting a partial object still parses,
 * but Zod 4 requires defaulted shapes to match output types — so we use
 * explicit literals in `emptyQuote()` rather than chained `.default({})`s.
 */

const ClientSchema = z.object({
	name: z.string().max(200).default(''),
	email: z.union([z.string().email('Invalid email'), z.literal('')]).default(''),
	phone: z.string().max(50).default(''),
	notes: z.string().max(2000).default('')
});

const SiteSchema = z.object({
	address: z.string().max(500).default(''),
	geocode: z
		.object({ lat: z.number(), lng: z.number() })
		.nullable()
		.default(null),
	propertyBoundaryGeoJson: z
		.object({
			type: z.literal('Polygon'),
			coordinates: z.array(z.array(z.tuple([z.number(), z.number()])))
		})
		.nullable()
		.default(null),
	// Marks that we already tried to fetch the cadastre. Distinguishes
	// "haven't asked yet" from "asked and got nothing back" so we don't
	// re-fetch the boundary every time someone opens Step 2.
	boundaryAttempted: z.boolean().default(false),
	state: z
		.enum(['QLD', 'NSW', 'VIC', 'SA', 'WA', 'TAS', 'ACT', 'NT'])
		.nullable()
		.default(null),
	postcode: z.union([z.string().regex(/^\d{4}$/), z.literal('')]).default(''),
	/** Reference frame for RGL/NGL values shown in Step 3 and downstream PDFs.
	 *  - 'site': arbitrary site benchmark, all heights relative to it (default)
	 *  - 'ahd': Australian Height Datum — heights are absolute AHD elevations
	 *  - 'relative': no datum, heights are just numbers
	 */
	verticalDatum: z.enum(['site', 'ahd', 'relative']).default('site')
});

const PostSchema = z.object({
	index: z.number().int().nonnegative(),
	rglMm: z.number(),
	nglMm: z.number(),
	pierDiameterMm: z.number().int().positive().nullable().default(null),
	embedmentMm: z.number().int().positive().nullable().default(null)
});

const WallDefaultsSchema = z.object({
	boundaryOffsetMm: z.number().int().nonnegative().default(100),
	panelModuleMm: z.number().int().positive().default(200),
	postSpacingMm: z.number().int().positive().default(2400),
	concreteStrength: z.enum(['N25', 'N32']).default('N25')
});

/**
 * GeoJSON path for a wall. WGS84 [lng, lat] coordinates.
 *
 * MultiLineString is the canonical shape — a wall can have multiple
 * disconnected sub-segments (e.g., front fence + side fence with a gate
 * between them). LineString is accepted for backward compatibility with
 * earlier saved data and is treated as a single-element MultiLineString.
 */
const PathGeoJsonSchema = z.union([
	z.object({
		type: z.literal('LineString'),
		coordinates: z.array(z.tuple([z.number(), z.number()]))
	}),
	z.object({
		type: z.literal('MultiLineString'),
		coordinates: z.array(z.array(z.tuple([z.number(), z.number()])))
	})
]);

const WallSchema = z.object({
	id: z.string().min(1),
	name: z.string().default('Wall 1'),
	pathGeoJson: PathGeoJsonSchema.nullable().default(null),
	posts: z.array(PostSchema).default([]),
	defaults: WallDefaultsSchema.default(() => WallDefaultsSchema.parse({}))
});

export type WallPathGeoJson = z.infer<typeof PathGeoJsonSchema>;

const MaterialsSchema = z.object({
	blockType: z.string().default(''),
	capping: z.string().default(''),
	drainage: z.string().default(''),
	notes: z.string().max(2000).default('')
});

const PricingSchema = z.object({
	subtotalCents: z.number().int().nonnegative().default(0),
	marginPct: z.number().min(0).max(100).default(20),
	gstPct: z.number().min(0).max(100).default(10),
	totalCents: z.number().int().nonnegative().default(0),
	rates: z.record(z.string(), z.number().nonnegative()).default({})
});

const FlagsSchema = z.object({
	engineerCertRequired: z.boolean().default(false),
	surchargeLoad: z.boolean().default(false)
});

const MetaSchema = z.object({
	notes: z.string().max(4000).default(''),
	flags: FlagsSchema.default(() => FlagsSchema.parse({}))
});

export const QuoteDataSchema = z.object({
	schemaVersion: z.literal(1).default(1),
	client: ClientSchema.default(() => ClientSchema.parse({})),
	site: SiteSchema.default(() => SiteSchema.parse({})),
	walls: z.array(WallSchema).default([]),
	materials: MaterialsSchema.default(() => MaterialsSchema.parse({})),
	pricing: PricingSchema.default(() => PricingSchema.parse({})),
	meta: MetaSchema.default(() => MetaSchema.parse({}))
});

export type QuoteData = z.infer<typeof QuoteDataSchema>;

/** Empty quote — used when creating a new draft. */
export function emptyQuote(): QuoteData {
	return QuoteDataSchema.parse({});
}
