import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from './auth-utils';

const prismaMock = vi.hoisted(() => ({
	$transaction: vi.fn(),
	passwordResetToken: {
		deleteMany: vi.fn(),
		create: vi.fn(),
		findUnique: vi.fn(),
		delete: vi.fn()
	},
	session: {
		deleteMany: vi.fn()
	},
	user: {
		update: vi.fn()
	}
}));

vi.mock('./db', () => ({
	prisma: prismaMock
}));

import {
	consumePasswordResetToken,
	getPasswordResetTokenStatus,
	getSessionCookieOptions,
	issuePasswordResetToken,
	verifyPassword
} from './auth';

beforeEach(() => {
	vi.clearAllMocks();
	prismaMock.passwordResetToken.delete.mockResolvedValue({});
	prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
});

describe('auth session cookie', () => {
	it('uses SameSite=Lax so Android PWA launches keep the session cookie', () => {
		expect(getSessionCookieOptions()).toMatchObject({
			path: '/',
			httpOnly: true,
			sameSite: 'lax'
		});
	});
});

describe('password reset tokens', () => {
	it('stores only a token hash when issuing a reset token', async () => {
		const { token, expiresAt } = await issuePasswordResetToken('user-1');

		expect(token).toBeTruthy();
		expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
		expect(prismaMock.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
		expect(prismaMock.passwordResetToken.create).toHaveBeenCalledWith({
			data: {
				userId: 'user-1',
				tokenHash: hashToken(token),
				expiresAt
			}
		});
	});

	it('rejects invalid and expired reset tokens', async () => {
		prismaMock.passwordResetToken.findUnique.mockResolvedValueOnce(null);

		await expect(getPasswordResetTokenStatus('missing-token')).resolves.toBe('invalid');

		prismaMock.passwordResetToken.findUnique.mockResolvedValueOnce({
			id: 'reset-1',
			expiresAt: new Date(Date.now() - 1000)
		});

		await expect(getPasswordResetTokenStatus('expired-token')).resolves.toBe('expired');
		expect(prismaMock.passwordResetToken.delete).toHaveBeenCalledWith({ where: { id: 'reset-1' } });
	});

	it('updates the password and clears reset tokens plus sessions', async () => {
		prismaMock.passwordResetToken.findUnique.mockResolvedValueOnce({
			id: 'reset-1',
			userId: 'user-1',
			expiresAt: new Date(Date.now() + 60_000)
		});

		await expect(consumePasswordResetToken('valid-token', 'new-secure-password')).resolves.toBe('reset');

		expect(prismaMock.user.update).toHaveBeenCalledWith({
			where: { id: 'user-1' },
			data: {
				passwordHash: expect.any(String)
			}
		});
		const passwordHash = prismaMock.user.update.mock.calls[0][0].data.passwordHash;
		expect(passwordHash).not.toBe('new-secure-password');
		expect(verifyPassword('new-secure-password', passwordHash)).toBe(true);
		expect(prismaMock.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
		expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
	});
});
