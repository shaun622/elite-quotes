import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { makeDb } from '$lib/server/db';
import { deleteQuote, listQuotesForOrg } from '$lib/server/quotes/repo';

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.org) error(500, 'org missing');
	if (!platform?.env) error(500, 'platform bindings missing');
	const db = makeDb(platform.env.DB);
	const rows = await listQuotesForOrg({ db, orgId: locals.org.id });
	return { quotes: rows };
};

export const actions: Actions = {
	delete: async ({ request, locals, platform, getClientAddress }) => {
		if (!locals.user || !locals.org) error(401, 'Authentication required');
		if (!platform?.env) error(500, 'platform bindings missing');

		// Owner-only — destructive and irreversible.
		if (locals.role !== 'owner') {
			return fail(403, {
				error: 'Only owners can delete quotes. Estimators can archive instead.'
			});
		}

		const data = await request.formData();
		const quoteId = data.get('quoteId');
		if (typeof quoteId !== 'string' || !quoteId) {
			return fail(400, { error: 'Missing quote id' });
		}

		const db = makeDb(platform.env.DB);
		const result = await deleteQuote({
			db,
			orgId: locals.org.id,
			userId: locals.user.id,
			quoteId,
			ip: getClientAddress(),
			ua: request.headers.get('user-agent')
		});

		if (!result.ok) {
			return fail(404, { error: 'Quote not found or already deleted' });
		}
		return { ok: true, deletedId: quoteId };
	}
};
