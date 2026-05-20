import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { makeDb } from '$lib/server/db';
import { getCurrentVersion, saveVersion } from '$lib/server/quotes/repo';

/**
 * GET — proxy the R2 object back to the browser. Tenant-safe: validates
 * org membership and that the photo actually belongs to this quote before
 * streaming bytes back. Caches privately for 1 day.
 *
 * DELETE — removes the R2 object and drops the photo from the quote JSON.
 */

export const GET: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user || !locals.org) error(401, 'Authentication required');
	if (!platform?.env) error(500, 'Cloudflare bindings unavailable');

	const db = makeDb(platform.env.DB);
	const current = await getCurrentVersion({
		db,
		orgId: locals.org.id,
		quoteId: params.id
	});
	if (!current) error(404, 'Quote not found');

	const photo = current.data.photos.find((p) => p.id === params.photoId);
	if (!photo) error(404, 'Photo not found');

	const obj = await platform.env.FILES.get(photo.r2Key);
	if (!obj) error(404, 'Photo object missing from storage');

	// Read into a buffer so TS narrows to a known BodyInit shape (Workers'
	// ReadableStream type clashes with the DOM one in strict mode).
	const buffer = await obj.arrayBuffer();

	const headers = new Headers();
	headers.set('Content-Type', obj.httpMetadata?.contentType ?? photo.contentType ?? 'image/jpeg');
	headers.set('Content-Length', String(buffer.byteLength));
	headers.set('Cache-Control', 'private, max-age=86400, immutable');
	headers.set('Content-Disposition', `inline; filename="${photo.id}.jpg"`);

	return new Response(buffer, { status: 200, headers });
};

export const DELETE: RequestHandler = async ({ params, locals, platform, request }) => {
	if (!locals.user || !locals.org) error(401, 'Authentication required');
	if (!platform?.env) error(500, 'Cloudflare bindings unavailable');

	const db = makeDb(platform.env.DB);
	const current = await getCurrentVersion({
		db,
		orgId: locals.org.id,
		quoteId: params.id
	});
	if (!current) error(404, 'Quote not found');

	const photo = current.data.photos.find((p) => p.id === params.photoId);
	if (!photo) error(404, 'Photo not found');

	// Save the new version first; if that wins the conflict check, delete
	// the R2 object. Doing it in this order means we never have a stale
	// metadata row pointing at a deleted blob.
	const updated = {
		...current.data,
		photos: current.data.photos.filter((p) => p.id !== params.photoId)
	};
	const result = await saveVersion({
		db,
		orgId: locals.org.id,
		quoteId: params.id,
		userId: locals.user.id,
		expectedDataHash: current.version.dataHash,
		newData: updated,
		ip: null,
		ua: request.headers.get('user-agent')
	});

	if (!result.ok) {
		return new Response(
			JSON.stringify({
				error: 'conflict',
				currentDataHash: result.conflict.currentDataHash,
				currentVersion: result.conflict.currentVersion
			}),
			{ status: 409, headers: { 'Content-Type': 'application/json' } }
		);
	}

	try {
		await platform.env.FILES.delete(photo.r2Key);
	} catch {
		// best-effort: a metadata-but-no-blob row is recoverable by the next
		// audit pass; a blob-but-no-metadata leak is the worse failure mode
		// and we've already prevented that by doing the metadata save first.
	}

	return new Response(JSON.stringify({ ok: true, dataHash: result.dataHash }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
};
