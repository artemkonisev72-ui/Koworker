import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { clearSessionCookie, getSession, SESSION_COOKIE_NAME } from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	const sessionToken = event.cookies.get(SESSION_COOKIE_NAME);

	if (!sessionToken) {
		event.locals.user = null;
		event.locals.session = null;
	} else {
		const session = await getSession(sessionToken);
		if (session) {
			event.locals.user = {
				id: session.user.id,
				email: session.user.email,
				name: session.user.name,
				emailVerifiedAt: session.user.emailVerifiedAt
			};
			event.locals.session = {
				id: session.id,
				expiresAt: session.expiresAt
			};
		} else {
			event.locals.user = null;
			event.locals.session = null;
			clearSessionCookie(event.cookies);
		}
	}

	// Protect routes (except login/register)
	if (!event.locals.user && 
		!event.url.pathname.startsWith('/login') && 
		!event.url.pathname.startsWith('/register') &&
		event.url.pathname !== '/') {
		// In a real app we might redirect, but for now we'll just let the components handle it 
		// or redirect in +page.server.ts
	}

	return resolve(event);
};
