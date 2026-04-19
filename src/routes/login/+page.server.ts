import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	backfillLegacyUser,
	createSession,
	findUserByNormalizedEmail,
	isEmailFormatValid,
	isUserEmailVerified,
	normalizeEmail,
	setSessionCookie,
	verifyPassword
} from '$lib/server/auth';
import { enforceAuthRateLimit } from '$lib/server/auth-throttle';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) {
		throw redirect(302, '/');
	}

	return {
		verified: url.searchParams.get('verified') === '1'
	};
};

export const actions: Actions = {
	default: async (event) => {
		const { request, cookies } = event;
		const data = await request.formData();
		const rawEmail = data.get('email')?.toString() ?? '';
		const rawPassword = data.get('password')?.toString() ?? '';
		const emailTrimmed = rawEmail.trim();
		const emailNormalized = normalizeEmail(rawEmail);

		if (!isEmailFormatValid(emailNormalized) || !rawPassword) {
			return fail(400, { email: emailTrimmed, message: 'Invalid email or password.' });
		}

		const rateLimit = await enforceAuthRateLimit(event, 'login', emailNormalized);
		if (!rateLimit.allowed) {
			return fail(429, {
				email: emailTrimmed,
				message: `Too many requests. Try again in ${rateLimit.retryAfterSeconds} seconds.`
			});
		}

		let user = await findUserByNormalizedEmail(emailNormalized);
		if (!user || !verifyPassword(rawPassword, user.passwordHash)) {
			return fail(400, { email: emailTrimmed, message: 'Invalid email or password.' });
		}

		if (!user.emailNormalized) {
			user = await backfillLegacyUser(user);
		}

		if (!isUserEmailVerified(user)) {
			throw redirect(303, `/verify-email?email=${encodeURIComponent(emailNormalized)}`);
		}

		const sessionToken = await createSession(user.id);
		setSessionCookie(cookies, sessionToken);
		throw redirect(303, '/?postLogin=1');
	}
};
