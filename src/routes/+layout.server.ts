import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url, setHeaders }) => {
	setHeaders({
		'Cache-Control': 'no-store'
	});

	return {
		user: locals.user,
		postLogin: url.searchParams.get('postLogin') === '1'
	};
};
