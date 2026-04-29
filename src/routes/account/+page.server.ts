import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { issuePasswordResetToken, normalizeEmail, sanitizeDisplayName } from '$lib/server/auth';
import { sendPasswordResetEmail } from '$lib/server/auth-email';
import { enforceAuthRateLimit } from '$lib/server/auth-throttle';
import { prisma } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	return {
		user: locals.user
	};
};

export const actions: Actions = {
	updateName: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, '/login');
		}

		const data = await request.formData();
		const displayName = sanitizeDisplayName(data.get('name')?.toString());

		if (!displayName) {
			return fail(400, {
				action: 'updateName',
				success: false,
				name: data.get('name')?.toString() ?? '',
				message: 'Введите никнейм.'
			});
		}

		await prisma.user.update({
			where: { id: locals.user.id },
			data: { name: displayName }
		});

		locals.user = {
			...locals.user,
			name: displayName
		};

		return {
			action: 'updateName',
			success: true,
			name: displayName,
			message: 'Никнейм сохранён.'
		};
	},

	requestPasswordReset: async (event) => {
		const { locals, url } = event;
		if (!locals.user) {
			throw redirect(302, '/login');
		}

		const emailNormalized = normalizeEmail(locals.user.email);
		const rateLimit = await enforceAuthRateLimit(event, 'password-reset', emailNormalized);
		if (!rateLimit.allowed) {
			return fail(429, {
				action: 'requestPasswordReset',
				success: false,
				message: `Слишком много запросов. Попробуйте ещё раз через ${rateLimit.retryAfterSeconds} сек.`
			});
		}

		const { token } = await issuePasswordResetToken(locals.user.id);
		await sendPasswordResetEmail({
			to: locals.user.email,
			name: locals.user.name,
			token,
			baseUrl: url.origin
		});

		return {
			action: 'requestPasswordReset',
			success: true,
			message: 'Письмо для смены пароля отправлено. Письмо может прийти в папку "Спам".'
		};
	}
};
