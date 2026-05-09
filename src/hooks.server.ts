import type { Handle, HandleServerError } from '@sveltejs/kit';
import { makeAuth } from '$lib/server/auth';
import { makeDb } from '$lib/server/db';
import { resolveOrCreateMembership } from '$lib/server/orgs/bootstrap';
import { captureException } from '$lib/server/observability';

export const handle: Handle = async ({ event, resolve }) => {
	const requestId = event.request.headers.get('cf-ray') ?? crypto.randomUUID();
	event.locals.requestId = requestId;
	event.locals.user = null;
	event.locals.org = null;
	event.locals.role = null;

	if (!event.platform?.env) {
		// Local dev without `wrangler pages dev` shouldn't crash, but we can't auth either.
		return resolve(event);
	}

	const env = event.platform.env;
	const auth = makeAuth(env);

	let session: Awaited<ReturnType<typeof auth.api.getSession>> = null;
	try {
		session = await auth.api.getSession({ headers: event.request.headers });
	} catch (err) {
		captureException(err, { requestId, where: 'auth.getSession' });
	}

	if (session?.user) {
		event.locals.user = { id: session.user.id, email: session.user.email };

		// Resolve org + role. This also runs the bootstrap path on first sign-in
		// for the configured BOOTSTRAP_OWNER_EMAIL.
		try {
			const db = makeDb(env.DB);
			const membership = await resolveOrCreateMembership({
				db,
				user: event.locals.user,
				bootstrapEmail: (env.BOOTSTRAP_OWNER_EMAIL ?? '').trim()
			});
			if (membership) {
				event.locals.org = {
					id: membership.orgId,
					slug: membership.orgSlug,
					name: membership.orgName
				};
				event.locals.role = membership.role;
			}
		} catch (err) {
			captureException(err, {
				requestId,
				userId: event.locals.user.id,
				where: 'resolveOrCreateMembership'
			});
		}
	}

	return resolve(event);
};

export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const { id } = captureException(error, {
		requestId: event.locals?.requestId,
		path: event.url.pathname,
		status
	});
	return { message: message ?? 'Internal error', id, code: 'INTERNAL' };
};
