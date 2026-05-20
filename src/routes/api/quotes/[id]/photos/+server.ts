import { error, json } from '@sveltejs/kit';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { makeDb } from '$lib/server/db';
import { getCurrentVersion, saveVersion } from '$lib/server/quotes/repo';
import type { Photo } from '$lib/schemas/quote';

/**
 * POST multipart/form-data with one or more files in the `files` field.
 * Stores each in R2 under `quotes/{quoteId}/photos/{photoId}`, appends
 * metadata to the canonical quote JSON, returns the updated photo list.
 *
 * No size/format validation beyond a 10 MB ceiling — the iPad camera in
 * the field is the primary upload path and JPEG is the standard output.
 */

const ALLOWED_MIME = /^image\/(jpe?g|png|webp|heic|heif)$/i;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per photo

export const POST: RequestHandler = async ({ request, params, locals, platform }) => {
	if (!locals.user || !locals.org) error(401, 'Authentication required');
	if (!platform?.env) error(500, 'Cloudflare bindings unavailable');

	const ct = request.headers.get('content-type') ?? '';
	if (!ct.toLowerCase().includes('multipart/form-data')) {
		error(400, 'Expected multipart/form-data with `files` field');
	}

	const formData = await request.formData();
	const uploaded = formData.getAll('files');
	if (uploaded.length === 0) error(400, 'No files in payload');

	const db = makeDb(platform.env.DB);
	const current = await getCurrentVersion({
		db,
		orgId: locals.org.id,
		quoteId: params.id
	});
	if (!current) error(404, 'Quote not found');

	const newPhotos: Photo[] = [];
	for (const f of uploaded) {
		if (!(f instanceof File)) continue;
		if (f.size > MAX_BYTES) error(413, `Photo "${f.name}" exceeds 10 MB`);
		if (f.type && !ALLOWED_MIME.test(f.type)) {
			error(415, `Unsupported type "${f.type}" — JPEG / PNG / WebP / HEIC only`);
		}
		const photoId = ulid();
		const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
		const r2Key = `quotes/${params.id}/photos/${photoId}.${ext}`;
		const bytes = new Uint8Array(await f.arrayBuffer());
		await platform.env.FILES.put(r2Key, bytes, {
			httpMetadata: {
				contentType: f.type || 'image/jpeg',
				cacheControl: 'private, max-age=86400'
			}
		});
		newPhotos.push({
			id: photoId,
			r2Key,
			contentType: f.type || 'image/jpeg',
			label: f.name || '',
			width: null,
			height: null,
			sizeBytes: f.size,
			uploadedAt: Date.now()
		});
	}

	const updated = { ...current.data, photos: [...current.data.photos, ...newPhotos] };
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
		// Roll back the R2 objects we just wrote so we don't leak orphans.
		for (const p of newPhotos) {
			try {
				await platform.env.FILES.delete(p.r2Key);
			} catch {
				/* best-effort */
			}
		}
		return new Response(
			JSON.stringify({
				error: 'conflict',
				currentDataHash: result.conflict.currentDataHash,
				currentVersion: result.conflict.currentVersion
			}),
			{ status: 409, headers: { 'Content-Type': 'application/json' } }
		);
	}

	return json({
		photos: updated.photos,
		dataHash: result.dataHash,
		versionNumber: result.versionNumber
	});
};
