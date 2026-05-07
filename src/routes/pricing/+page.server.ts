import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getActivePlans, getBillingSummary } from '$lib/server/billing/subscriptions';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const [billing, plans] = await Promise.all([getBillingSummary(locals.user.id), getActivePlans()]);

	return {
		user: locals.user,
		billing,
		plans
	};
};
