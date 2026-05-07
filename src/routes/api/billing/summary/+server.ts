import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { getBillingSummary } from '$lib/server/billing/subscriptions.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return error(401, 'Нужно войти в аккаунт.');
	return json(await getBillingSummary(locals.user.id));
};
