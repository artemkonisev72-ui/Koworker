import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
	prisma: {}
}));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { getSessionCookieOptions } from './auth.ts';

describe('auth session cookie', () => {
	it('uses SameSite=Lax so Android PWA launches keep the session cookie', () => {
		expect(getSessionCookieOptions()).toMatchObject({
			path: '/',
			httpOnly: true,
			sameSite: 'lax'
		});
	});
});
