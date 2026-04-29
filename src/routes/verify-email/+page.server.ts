import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	backfillLegacyUser,
	consumeEmailVerificationToken,
	findUserByNormalizedEmail,
	isEmailFormatValid,
	isUserEmailVerified,
	issueEmailVerificationToken,
	normalizeEmail
} from '$lib/server/auth';
import { sendVerificationEmail } from '$lib/server/auth-email';
import { enforceAuthRateLimit } from '$lib/server/auth-throttle';

function normalizeEmailFromQuery(value: string | null): string {
	if (!value) return '';
	const normalized = normalizeEmail(value);
	return isEmailFormatValid(normalized) ? normalized : '';
}

export const load: PageServerLoad = async ({ url, locals }) => {
	const token = url.searchParams.get('token');
	if (token) {
		const status = await consumeEmailVerificationToken(token);
		if (status === 'verified') {
			throw redirect(303, '/login?verified=1');
		}

		return {
			email: '',
			tokenStatus: status
		};
	}

	if (locals.user) {
		throw redirect(302, '/');
	}

	return {
		email: normalizeEmailFromQuery(url.searchParams.get('email')),
		tokenStatus: null as null
	};
};

export const actions: Actions = {
	default: async (event) => {
		const { request, url } = event;
		const data = await request.formData();
		const rawEmail = data.get('email')?.toString() ?? '';
		const emailNormalized = normalizeEmail(rawEmail);

		if (!isEmailFormatValid(emailNormalized)) {
			return fail(400, { email: rawEmail.trim(), message: 'Введите корректный адрес электронной почты.', success: false });
		}

		const rateLimit = await enforceAuthRateLimit(event, 'resend', emailNormalized);
		if (!rateLimit.allowed) {
			return fail(429, {
				email: emailNormalized,
				success: false,
				message: `Слишком много запросов. Попробуйте ещё раз через ${rateLimit.retryAfterSeconds} сек.`
			});
		}

		let user = await findUserByNormalizedEmail(emailNormalized);
		if (user && !user.emailNormalized) {
			user = await backfillLegacyUser(user);
		}

		if (user && !isUserEmailVerified(user)) {
			const { token } = await issueEmailVerificationToken(user.id);
			await sendVerificationEmail({
				to: user.email,
				name: user.name,
				token,
				baseUrl: url.origin
			});
		}

		return {
			email: emailNormalized,
			success: true,
			message: 'Если этот адрес зарегистрирован, ссылка для подтверждения отправлена. Письмо может прийти в папку "Спам".'
		};
	}
};
