import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import { refreshSubscriptionPlanBudgets } from '$lib/server/billing/subscriptions.js';

function authorized(request: Request): boolean {
	const secret = env.BILLING_CRON_SECRET?.trim();
	if (!secret) return false;
	const auth = request.headers.get('authorization') ?? '';
	const headerSecret = request.headers.get('x-cron-secret') ?? '';
	return auth === `Bearer ${secret}` || headerSecret === secret;
}

export const POST: RequestHandler = async ({ request }) => {
	if (!authorized(request)) return error(401, 'Unauthorized');
	const result = await refreshSubscriptionPlanBudgets();
	return json(result);
};
