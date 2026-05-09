import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { makeDb } from '$lib/server/db';
import { getCurrentVersion } from '$lib/server/quotes/repo';
import { isValidStep } from '$lib/wizard';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	if (!locals.user || !locals.org) error(401, 'Authentication required');
	if (!platform?.env) error(500, 'platform bindings missing');

	const stepNum = Number(params.step);
	if (!isValidStep(stepNum)) error(404, 'Unknown step');

	const db = makeDb(platform.env.DB);
	const result = await getCurrentVersion({
		db,
		orgId: locals.org.id,
		quoteId: params.quoteId
	});
	if (!result) error(404, 'Quote not found');

	return {
		quoteId: params.quoteId,
		step: stepNum,
		quoteNumber: result.quote.quoteNumber,
		data: result.data,
		dataHash: result.version.dataHash,
		versionNumber: result.version.versionNumber
	};
};
