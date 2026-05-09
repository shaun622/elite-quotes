import { fail, redirect, error } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { makeAuth } from '$lib/server/auth';
import { makeDb } from '$lib/server/db';
import { isLoginAllowed } from '$lib/server/orgs/bootstrap';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user && locals.org) {
		const next = url.searchParams.get('next') ?? '/quotes';
		redirect(303, next);
	}
	return {};
};

const schema = z.object({
	email: z
		.string()
		.trim()
		.toLowerCase()
		.email('Enter a valid email address.')
});

export const actions: Actions = {
	default: async ({ request, platform, url }) => {
		if (!platform?.env) error(500, 'Cloudflare bindings unavailable');

		const data = await request.formData();
		const parsed = schema.safeParse({ email: data.get('email') });
		if (!parsed.success) {
			return fail(400, {
				email: String(data.get('email') ?? ''),
				error: parsed.error.issues[0]?.message ?? 'Invalid input.'
			});
		}

		const { email } = parsed.data;
		const db = makeDb(platform.env.DB);

		const allowed = await isLoginAllowed({
			db,
			email,
			bootstrapEmail: (platform.env.BOOTSTRAP_OWNER_EMAIL ?? '').trim()
		});

		if (!allowed) {
			return fail(403, {
				email,
				error:
					'This email is not registered. Contact your administrator to be invited to a workspace.'
			});
		}

		const auth = makeAuth(platform.env);
		const callbackURL = url.searchParams.get('next') ?? '/quotes';

		try {
			await auth.api.signInMagicLink({
				body: { email, callbackURL },
				headers: request.headers
			});
		} catch (e) {
			console.error('magic-link send failed', e);
			return fail(500, { email, error: 'Could not send the sign-in link. Try again shortly.' });
		}

		return { sent: true, email };
	}
};
