import type { User } from '@prisma/client';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { prisma } from './db';
import {
	generateOpaqueToken,
	hashPassword,
	hashToken,
	isEmailFormatValid,
	isPasswordFormatValid,
	normalizeEmail,
	sanitizeDisplayName,
	verifyPassword
} from './auth-utils';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_MAX_AGE_SECONDS = Math.floor(SESSION_DURATION_MS / 1000);
const DEFAULT_EMAIL_VERIFY_TTL_MINUTES = 24 * 60;
const DEFAULT_PASSWORD_RESET_TTL_MINUTES = 60;
const EMAIL_VERIFY_TTL_MINUTES_VALUE = Number.parseInt(env.EMAIL_VERIFY_TTL_MINUTES || '', 10);
const PASSWORD_RESET_TTL_MINUTES_VALUE = Number.parseInt(env.PASSWORD_RESET_TTL_MINUTES || '', 10);

export const SESSION_COOKIE_NAME = 'session';
export { hashPassword, isEmailFormatValid, isPasswordFormatValid, normalizeEmail, sanitizeDisplayName, verifyPassword };

function cookieIsSecure(): boolean {
	return process.env.NODE_ENV === 'production';
}

function getEmailVerifyTtlMinutes(): number {
	if (Number.isFinite(EMAIL_VERIFY_TTL_MINUTES_VALUE) && EMAIL_VERIFY_TTL_MINUTES_VALUE > 0) {
		return EMAIL_VERIFY_TTL_MINUTES_VALUE;
	}
	return DEFAULT_EMAIL_VERIFY_TTL_MINUTES;
}

function getPasswordResetTtlMinutes(): number {
	if (Number.isFinite(PASSWORD_RESET_TTL_MINUTES_VALUE) && PASSWORD_RESET_TTL_MINUTES_VALUE > 0) {
		return PASSWORD_RESET_TTL_MINUTES_VALUE;
	}
	return DEFAULT_PASSWORD_RESET_TTL_MINUTES;
}

export function isLegacyUnmigratedUser(user: Pick<User, 'emailNormalized' | 'emailVerifiedAt'>): boolean {
	return !user.emailNormalized && !user.emailVerifiedAt;
}

export function isUserEmailVerified(user: Pick<User, 'emailNormalized' | 'emailVerifiedAt'>): boolean {
	return Boolean(user.emailVerifiedAt) || isLegacyUnmigratedUser(user);
}

export async function findUserByNormalizedEmail(emailNormalized: string): Promise<User | null> {
	const byNormalized = await prisma.user.findUnique({ where: { emailNormalized } });
	if (byNormalized) return byNormalized;

	return prisma.user.findFirst({
		where: {
			email: {
				equals: emailNormalized,
				mode: 'insensitive'
			}
		}
	});
}

export async function backfillLegacyUser(user: Pick<User, 'id' | 'email' | 'emailNormalized' | 'emailVerifiedAt'>): Promise<User> {
	if (user.emailNormalized) {
		return user as User;
	}

	const normalized = normalizeEmail(user.email);
	try {
		return await prisma.user.update({
			where: { id: user.id },
			data: {
				emailNormalized: normalized,
				emailVerifiedAt: user.emailVerifiedAt ?? new Date()
			}
		});
	} catch {
		return prisma.user.findUniqueOrThrow({ where: { id: user.id } });
	}
}

export async function createSession(userId: string): Promise<string> {
	const sessionToken = generateOpaqueToken();
	const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

	await prisma.session.create({
		data: {
			userId,
			tokenHash: hashToken(sessionToken),
			expiresAt
		}
	});

	return sessionToken;
}

async function findSessionByTokenOrLegacyId(sessionToken: string) {
	const byTokenHash = await prisma.session.findUnique({
		where: { tokenHash: hashToken(sessionToken) },
		include: { user: true }
	});
	if (byTokenHash) return byTokenHash;

	return prisma.session.findUnique({
		where: { id: sessionToken },
		include: { user: true }
	});
}

export async function getSession(sessionToken: string) {
	const session = await findSessionByTokenOrLegacyId(sessionToken);
	if (!session || session.expiresAt.getTime() < Date.now()) {
		if (session) await deleteSession(sessionToken);
		return null;
	}

	if (isLegacyUnmigratedUser(session.user)) {
		const migratedUser = await backfillLegacyUser(session.user);
		return {
			...session,
			user: migratedUser
		};
	}

	return session;
}

export async function deleteSession(sessionToken: string): Promise<void> {
	await prisma.session.deleteMany({
		where: {
			OR: [{ tokenHash: hashToken(sessionToken) }, { id: sessionToken }]
		}
	});
}

export function getSessionCookieOptions() {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: cookieIsSecure(),
		maxAge: SESSION_COOKIE_MAX_AGE_SECONDS
	};
}

export function setSessionCookie(cookies: Cookies, sessionToken: string): void {
	cookies.set(SESSION_COOKIE_NAME, sessionToken, getSessionCookieOptions());
}

export function clearSessionCookie(cookies: Cookies): void {
	const { maxAge: _maxAge, ...deleteOptions } = getSessionCookieOptions();
	cookies.delete(SESSION_COOKIE_NAME, deleteOptions);
}

export async function issueEmailVerificationToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
	const token = generateOpaqueToken();
	const expiresAt = new Date(Date.now() + getEmailVerifyTtlMinutes() * 60 * 1000);

	await prisma.$transaction(async (tx) => {
		await tx.emailVerificationToken.deleteMany({ where: { userId } });
		await tx.emailVerificationToken.create({
			data: {
				userId,
				tokenHash: hashToken(token),
				expiresAt
			}
		});
	});

	return { token, expiresAt };
}

export type ConsumeEmailVerificationResult = 'verified' | 'invalid' | 'expired';

export async function consumeEmailVerificationToken(rawToken: string): Promise<ConsumeEmailVerificationResult> {
	if (!rawToken) return 'invalid';

	const tokenHash = hashToken(rawToken);
	const tokenRecord = await prisma.emailVerificationToken.findUnique({
		where: { tokenHash },
		include: { user: true }
	});

	if (!tokenRecord) return 'invalid';

	if (tokenRecord.expiresAt.getTime() < Date.now()) {
		await prisma.emailVerificationToken.delete({ where: { id: tokenRecord.id } }).catch(() => {});
		return 'expired';
	}

	await prisma.$transaction(async (tx) => {
		await tx.user.update({
			where: { id: tokenRecord.userId },
			data: {
				emailVerifiedAt: new Date(),
				emailNormalized: tokenRecord.user.emailNormalized ?? normalizeEmail(tokenRecord.user.email)
			}
		});

		await tx.emailVerificationToken.deleteMany({
			where: { userId: tokenRecord.userId }
		});
	});

	return 'verified';
}

export async function issuePasswordResetToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
	const token = generateOpaqueToken();
	const expiresAt = new Date(Date.now() + getPasswordResetTtlMinutes() * 60 * 1000);

	await prisma.$transaction(async (tx) => {
		await tx.passwordResetToken.deleteMany({ where: { userId } });
		await tx.passwordResetToken.create({
			data: {
				userId,
				tokenHash: hashToken(token),
				expiresAt
			}
		});
	});

	return { token, expiresAt };
}

export type PasswordResetTokenStatus = 'valid' | 'invalid' | 'expired';

export async function getPasswordResetTokenStatus(rawToken: string): Promise<PasswordResetTokenStatus> {
	if (!rawToken) return 'invalid';

	const tokenHash = hashToken(rawToken);
	const tokenRecord = await prisma.passwordResetToken.findUnique({
		where: { tokenHash }
	});

	if (!tokenRecord) return 'invalid';

	if (tokenRecord.expiresAt.getTime() < Date.now()) {
		await prisma.passwordResetToken.delete({ where: { id: tokenRecord.id } }).catch(() => {});
		return 'expired';
	}

	return 'valid';
}

export type ConsumePasswordResetResult = 'reset' | 'invalid' | 'expired';

export async function consumePasswordResetToken(rawToken: string, newPassword: string): Promise<ConsumePasswordResetResult> {
	if (!rawToken) return 'invalid';

	const tokenHash = hashToken(rawToken);
	const tokenRecord = await prisma.passwordResetToken.findUnique({
		where: { tokenHash }
	});

	if (!tokenRecord) return 'invalid';

	if (tokenRecord.expiresAt.getTime() < Date.now()) {
		await prisma.passwordResetToken.delete({ where: { id: tokenRecord.id } }).catch(() => {});
		return 'expired';
	}

	await prisma.$transaction(async (tx) => {
		await tx.user.update({
			where: { id: tokenRecord.userId },
			data: {
				passwordHash: hashPassword(newPassword)
			}
		});

		await tx.passwordResetToken.deleteMany({
			where: { userId: tokenRecord.userId }
		});

		await tx.session.deleteMany({
			where: { userId: tokenRecord.userId }
		});
	});

	return 'reset';
}
