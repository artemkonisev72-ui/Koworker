import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearSessionCookie, deleteSession, SESSION_COOKIE_NAME } from '$lib/server/auth';

export const POST: RequestHandler = async ({ cookies }) => {
	const sessionToken = cookies.get(SESSION_COOKIE_NAME);
	if (sessionToken) {
		await deleteSession(sessionToken);
	}
	clearSessionCookie(cookies);
	return json({ success: true });
};
