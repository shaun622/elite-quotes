import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { makeDb } from '$lib/server/db';
import { createDraft } from '$lib/server/quotes/repo';

export const load: PageServerLoad = async ({ locals, platform, request, getClientAddress }) => {
	if (!locals.user || !locals.org) error(401, 'Authentication required');
	if (!platform?.env) error(500, 'platform bindings missing');
	const db = makeDb(platform.env.DB);
	const { quoteId } = await createDraft({
		db,
		orgId: locals.org.id,
		userId: locals.user.id,
		ip: getClientAddress(),
		ua: request.headers.get('user-agent')
	});
	redirect(303, `/quotes/${quoteId}/1`);
};
