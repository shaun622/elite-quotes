import type { RequestHandler } from './$types';
import { makeAuth } from '$lib/server/auth';
import { error } from '@sveltejs/kit';

const handler: RequestHandler = async ({ request, platform }) => {
	if (!platform?.env) error(500, 'Cloudflare bindings unavailable');
	const auth = makeAuth(platform.env);
	return auth.handler(request);
};

export const GET = handler;
export const POST = handler;
