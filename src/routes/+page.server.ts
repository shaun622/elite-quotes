import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user && locals.org) {
		redirect(303, '/quotes');
	}
	redirect(303, '/login');
};
