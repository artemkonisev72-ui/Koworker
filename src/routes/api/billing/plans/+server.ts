import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getActivePlans } from '$lib/server/billing/subscriptions.js';

export const GET: RequestHandler = async () => {
	return json({ plans: await getActivePlans() });
};
