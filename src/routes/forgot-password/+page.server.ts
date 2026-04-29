import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	backfillLegacyUser,
	findUserByNormalizedEmail,
	isEmailFormatValid,
	issuePasswordResetToken,
	normalizeEmail
} from '$lib/server/auth';
import { sendPasswordResetEmail } from '$lib/server/auth-email';
import { enforceAuthRateLimit } from '$lib/server/auth-throttle';

const SUCCESS_MESSAGE = 'Если этот адрес зарегистрирован, письмо для смены пароля отправлено. Письмо может прийти в папку "Спам".';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		throw redirect(302, '/account');
	}
};

export const actions: Actions = {
	default: async (event) => {
		const { request, url } = event;
		const data = await request.formData();
		const rawEmail = data.get('email')?.toString() ?? '';
		const emailTrimmed = rawEmail.trim();
		const emailNormalized = normalizeEmail(rawEmail);

		if (!isEmailFormatValid(emailNormalized)) {
			return fail(400, {
				email: emailTrimmed,
				success: false,
				message: 'Введите корректный адрес электронной почты.'
			});
		}

		const rateLimit = await enforceAuthRateLimit(event, 'password-reset', emailNormalized);
		if (!rateLimit.allowed) {
			return fail(429, {
				email: emailTrimmed,
				success: false,
				message: `Слишком много запросов. Попробуйте ещё раз через ${rateLimit.retryAfterSeconds} сек.`
			});
		}

		let user = await findUserByNormalizedEmail(emailNormalized);
		if (user && !user.emailNormalized) {
			user = await backfillLegacyUser(user);
		}

		if (user) {
			const { token } = await issuePasswordResetToken(user.id);
			await sendPasswordResetEmail({
				to: user.email,
				name: user.name,
				token,
				baseUrl: url.origin
			});
		}

		return {
			email: emailNormalized,
			success: true,
			message: SUCCESS_MESSAGE
		};
	}
};
