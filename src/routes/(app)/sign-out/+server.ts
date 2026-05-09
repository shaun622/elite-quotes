import { error, redirect } from '@sveltejs/kit';
import { makeAuth } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ platform, request }) => {
	if (!platform?.env) error(500, 'platform bindings missing');
	const auth = makeAuth(platform.env);
	try {
		await auth.api.signOut({ headers: request.headers });
	} catch {
		// signOut is idempotent — falling through to redirect is fine.
	}
	redirect(303, '/login');
};
