import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { makeDb } from '$lib/server/db';
import { getCurrentVersion } from '$lib/server/quotes/repo';
import { renderQuotePdf, type PdfPhoto, type PdfTemplate } from '$lib/server/pdf/render';

/**
 * GET /api/quotes/:id/pdf?template=client|installer
 *
 * Renders the current version of the quote as a PDF and streams it back.
 * Server-side via pdf-lib so the same template feeds email + browser
 * download + future R2 storage.
 */
export const GET: RequestHandler = async ({ params, url, locals, platform }) => {
	if (!locals.user || !locals.org) error(401, 'Authentication required');
	if (!platform?.env) error(500, 'Cloudflare bindings unavailable');

	const tmplParam = url.searchParams.get('template') ?? 'client';
	if (tmplParam !== 'client' && tmplParam !== 'installer') {
		error(400, 'template must be "client" or "installer"');
	}
	const template = tmplParam as PdfTemplate;

	const db = makeDb(platform.env.DB);
	const result = await getCurrentVersion({
		db,
		orgId: locals.org.id,
		quoteId: params.id
	});
	if (!result) error(404, 'Quote not found');

	// Fetch up to 4 photos from R2 in parallel — they'll be embedded on the
	// cover block of the PDF. Failures are silent; PDF still renders without.
	const photoBytes: PdfPhoto[] = [];
	const photosToInclude = result.data.photos.slice(0, 4);
	if (photosToInclude.length > 0) {
		const fetched = await Promise.all(
			photosToInclude.map(async (p) => {
				try {
					const obj = await platform.env.FILES.get(p.r2Key);
					if (!obj) return null;
					const bytes = new Uint8Array(await obj.arrayBuffer());
					return {
						id: p.id,
						contentType: p.contentType,
						bytes
					} satisfies PdfPhoto;
				} catch {
					return null;
				}
			})
		);
		for (const p of fetched) if (p) photoBytes.push(p);
	}

	const bytes = await renderQuotePdf(result.data, {
		quoteNumber: result.quote.quoteNumber,
		orgName: locals.org.name,
		template,
		photos: photoBytes
	});

	const downloadName = `EW-${result.quote.quoteNumber}${template === 'installer' ? '-installer' : ''}.pdf`;
	const inline = url.searchParams.get('inline') === '1';

	// Copy into a fresh ArrayBuffer so TS recognises it as BodyInit
	// (Uint8Array generics tripped strict mode on Workers types).
	const body = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(body).set(bytes);

	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Length': String(bytes.byteLength),
			'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${downloadName}"`,
			'Cache-Control': 'private, no-store'
		}
	});
};
