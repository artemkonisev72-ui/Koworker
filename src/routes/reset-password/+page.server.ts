import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	clearSessionCookie,
	consumePasswordResetToken,
	getPasswordResetTokenStatus,
	isPasswordFormatValid
} from '$lib/server/auth';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token') ?? '';

	return {
		token,
		tokenStatus: await getPasswordResetTokenStatus(token)
	};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const data = await request.formData();
		const token = data.get('token')?.toString() ?? '';
		const password = data.get('password')?.toString() ?? '';
		const passwordConfirm = data.get('passwordConfirm')?.toString() ?? '';

		if (!isPasswordFormatValid(password)) {
			return fail(400, {
				token,
				tokenStatus: 'valid',
				success: false,
				message: 'Пароль должен содержать от 6 до 128 символов.'
			});
		}

		if (password !== passwordConfirm) {
			return fail(400, {
				token,
				tokenStatus: 'valid',
				success: false,
				message: 'Пароли не совпадают.'
			});
		}

		const result = await consumePasswordResetToken(token, password);
		if (result === 'invalid') {
			return fail(400, {
				token: '',
				tokenStatus: 'invalid',
				success: false,
				message: 'Некорректная ссылка для смены пароля. Запросите новую.'
			});
		}

		if (result === 'expired') {
			return fail(400, {
				token: '',
				tokenStatus: 'expired',
				success: false,
				message: 'Срок действия ссылки истёк. Запросите новую.'
			});
		}

		clearSessionCookie(cookies);
		throw redirect(303, '/login?passwordChanged=1');
	}
};
