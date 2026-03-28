import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { prisma } from '$lib/server/db';
import { verifyPassword, createSession } from '$lib/server/auth';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		throw redirect(302, '/');
	}
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const data = await request.formData();
		const email = data.get('email')?.toString();
		const password = data.get('password')?.toString();

		if (!email || !password) {
			return fail(400, { email, message: 'Все поля обязательны' });
		}

		const user = await prisma.user.findUnique({ where: { email } });

		if (!user || !verifyPassword(password, user.passwordHash)) {
			return fail(400, { email, message: 'Неверный email или пароль' });
		}

		const sessionId = await createSession(user.id);
		cookies.set('session', sessionId, {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			secure: process.env.NODE_ENV === 'production',
			maxAge: 60 * 60 * 24 * 30 // 30 days
		});

		throw redirect(302, '/');
	}
};
