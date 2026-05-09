import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { PutQuoteBodySchema } from '$lib/schemas/api';
import { makeDb } from '$lib/server/db';
import { getCurrentVersion, saveVersion } from '$lib/server/quotes/repo';

/**
 * Canonical JSON contract for quotes.
 *
 *   GET   /api/quotes/:id.json     → { data, dataHash, versionNumber }   ETag set
 *   PUT   /api/quotes/:id.json     ← { data }; If-Match + Idempotency-Key required
 *                                  → { dataHash, versionNumber } | 409 conflict
 *
 * On 409 the client must NOT attempt to merge — the documented behaviour is
 * last-write-wins-with-toast: refetch via GET, replace local form state, surface
 * a "this quote was edited in another window" warning to the user. See plan
 * file for rationale.
 */

export const GET: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user || !locals.org) error(401, 'Authentication required');
	if (!platform?.env) error(500, 'Cloudflare bindings unavailable');

	const db = makeDb(platform.env.DB);
	const result = await getCurrentVersion({ db, orgId: locals.org.id, quoteId: params.id });
	if (!result) error(404, 'Quote not found');

	return json(
		{
			data: result.data,
			dataHash: result.version.dataHash,
			versionNumber: result.version.versionNumber
		},
		{
			headers: {
				ETag: `"${result.version.dataHash}"`,
				'Cache-Control': 'no-store'
			}
		}
	);
};

export const PUT: RequestHandler = async ({ params, request, locals, platform, getClientAddress }) => {
	if (!locals.user || !locals.org) error(401, 'Authentication required');
	if (!platform?.env) error(500, 'Cloudflare bindings unavailable');

	const ifMatch = request.headers.get('if-match')?.replace(/^"|"$/g, '');
	if (!ifMatch) error(428, 'If-Match header required');

	const idemKey = request.headers.get('idempotency-key');
	if (!idemKey) error(400, 'Idempotency-Key header required');
	if (idemKey.length > 128) error(400, 'Idempotency-Key too long');

	// Idempotency cache lookup — replays return the prior response untouched.
	const idemCacheKey = `idem:${locals.org.id}:${params.id}:${idemKey}`;
	const cached = await platform.env.CACHE.get(idemCacheKey);
	if (cached) {
		return new Response(cached, {
			status: 200,
			headers: { 'Content-Type': 'application/json', 'X-Idempotent-Replay': '1' }
		});
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		error(400, 'Invalid JSON');
	}
	const parsed = PutQuoteBodySchema.safeParse(raw);
	if (!parsed.success) {
		error(
			422,
			`Invalid quote data: ${parsed.error.issues
				.map((i) => `${i.path.join('.')}: ${i.message}`)
				.join('; ')}`
		);
	}

	const db = makeDb(platform.env.DB);
	const ip = getClientAddress();
	const ua = request.headers.get('user-agent');

	const result = await saveVersion({
		db,
		orgId: locals.org.id,
		quoteId: params.id,
		userId: locals.user.id,
		expectedDataHash: ifMatch,
		newData: parsed.data.data,
		ip,
		ua
	});

	if (!result.ok) {
		return new Response(
			JSON.stringify({
				error: 'conflict',
				currentDataHash: result.conflict.currentDataHash,
				currentVersion: result.conflict.currentVersion
			}),
			{
				status: 409,
				headers: {
					'Content-Type': 'application/json',
					ETag: `"${result.conflict.currentDataHash}"`
				}
			}
		);
	}

	const responseBody = JSON.stringify({
		dataHash: result.dataHash,
		versionNumber: result.versionNumber
	});

	// 10-minute idempotency window — covers retries from a flaky on-site connection.
	await platform.env.CACHE.put(idemCacheKey, responseBody, { expirationTtl: 600 });

	return new Response(responseBody, {
		status: 200,
		headers: {
			'Content-Type': 'application/json',
			ETag: `"${result.dataHash}"`,
			'Cache-Control': 'no-store'
		}
	});
};
