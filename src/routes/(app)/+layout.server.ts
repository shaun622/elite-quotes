import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		const next = encodeURIComponent(url.pathname + url.search);
		redirect(303, `/login?next=${next}`);
	}
	if (!locals.org) {
		// Logged in but no org membership — bootstrap path didn't apply.
		// Sign them out and surface a helpful message via the login page.
		redirect(303, '/login?error=no_membership');
	}
	return {
		user: locals.user,
		org: locals.org,
		role: locals.role
	};
};
