import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { makeDb } from '$lib/server/db';
import { listQuotesForOrg } from '$lib/server/quotes/repo';

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.org) error(500, 'org missing');
	if (!platform?.env) error(500, 'platform bindings missing');
	const db = makeDb(platform.env.DB);
	const rows = await listQuotesForOrg({ db, orgId: locals.org.id });
	return { quotes: rows };
};
