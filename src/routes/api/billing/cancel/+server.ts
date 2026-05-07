import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { cancelCurrentSubscription, getBillingSummary } from '$lib/server/billing/subscriptions.js';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return error(401, 'Нужно войти в аккаунт.');
	await cancelCurrentSubscription(locals.user.id);
	return json(await getBillingSummary(locals.user.id));
};
