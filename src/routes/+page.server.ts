import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// Если пользователь не авторизован — редирект на логин
	if (!locals.user) {
		throw redirect(302, '/login');
	}
	
	return {
		user: locals.user
	};
};
