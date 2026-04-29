import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	findUserByNormalizedEmail,
	hashPassword,
	isEmailFormatValid,
	isPasswordFormatValid,
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
			return fail(400, { email: emailTrimmed, message: 'Введите корректный адрес электронной почты.' });
		}

		if (!isPasswordFormatValid(rawPassword)) {
			return fail(400, {
				email: emailTrimmed,
				message: 'Пароль должен содержать от 6 до 128 символов.'
			});
		}

		const rateLimit = await enforceAuthRateLimit(event, 'register', emailNormalized);
		if (!rateLimit.allowed) {
			return fail(429, {
				email: emailTrimmed,
				message: `Слишком много запросов. Попробуйте ещё раз через ${rateLimit.retryAfterSeconds} сек.`
			});
		}

		if (await findUserByNormalizedEmail(emailNormalized)) {
			return fail(409, {
				email: emailTrimmed,
				message: 'Аккаунт с этой электронной почтой уже зарегистрирован. Войдите или восстановите пароль.'
			});
		}

		let user;
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
			if (await findUserByNormalizedEmail(emailNormalized)) {
				return fail(409, {
					email: emailTrimmed,
					message: 'Аккаунт с этой электронной почтой уже зарегистрирован. Войдите или восстановите пароль.'
				});
			}
			return fail(500, {
				email: emailTrimmed,
				message: 'Не удалось создать аккаунт. Попробуйте ещё раз.'
			});
		}

		const { token } = await issueEmailVerificationToken(user.id);
		await sendVerificationEmail({
			to: user.email,
			name: user.name,
			token,
			baseUrl: url.origin
		});

		verifyRedirect(emailNormalized);
	}
};
