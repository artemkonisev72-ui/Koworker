import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	backfillLegacyUser,
	findUserByNormalizedEmail,
	hashPassword,
	isEmailFormatValid,
	isPasswordFormatValid,
	isUserEmailVerified,
	issueEmailVerificationToken,
	normalizeEmail,
	sanitizeDisplayName
} from '$lib/server/auth';
import { sendVerificationEmail } from '$lib/server/auth-email';
import { enforceAuthRateLimit } from '$lib/server/auth-throttle';
import { prisma } from '$lib/server/db';

function verifyRedirect(emailNormalized: string): never {
	throw redirect(303, `/verify-email?email=${encodeURIComponent(emailNormalized)}`);
}

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		throw redirect(302, '/');
	}
};

export const actions: Actions = {
	default: async (event) => {
		const { request, url } = event;
		const data = await request.formData();
		const rawEmail = data.get('email')?.toString() ?? '';
		const rawPassword = data.get('password')?.toString() ?? '';
		const displayName = sanitizeDisplayName(data.get('name')?.toString());
		const emailTrimmed = rawEmail.trim();
		const emailNormalized = normalizeEmail(rawEmail);

		if (!isEmailFormatValid(emailNormalized)) {
			return fail(400, { email: emailTrimmed, message: 'Enter a valid email address.' });
		}

		if (!isPasswordFormatValid(rawPassword)) {
			return fail(400, {
				email: emailTrimmed,
				message: 'Password must be between 6 and 128 characters.'
			});
		}

		const rateLimit = await enforceAuthRateLimit(event, 'register', emailNormalized);
		if (!rateLimit.allowed) {
			return fail(429, {
				email: emailTrimmed,
				message: `Too many requests. Try again in ${rateLimit.retryAfterSeconds} seconds.`
			});
		}

		let user = await findUserByNormalizedEmail(emailNormalized);
		if (!user) {
			try {
				user = await prisma.user.create({
					data: {
						email: emailTrimmed,
						emailNormalized,
						name: displayName,
						passwordHash: hashPassword(rawPassword)
					}
				});
			} catch {
				user = await findUserByNormalizedEmail(emailNormalized);
				if (!user) {
					return fail(500, {
						email: emailTrimmed,
						message: 'Unable to create account right now. Please try again.'
					});
				}
			}
		}

		if (!user.emailNormalized) {
			user = await backfillLegacyUser(user);
		}

		if (!isUserEmailVerified(user)) {
			const { token } = await issueEmailVerificationToken(user.id);
			await sendVerificationEmail({
				to: user.email,
				name: user.name,
				token,
				baseUrl: url.origin
			});
		}

		verifyRedirect(emailNormalized);
	}
};
