import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const EMAIL_MAX_LENGTH = 254;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function generateOpaqueToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

export function normalizeEmail(email: string): string {
	return email.trim().normalize('NFKC').toLowerCase();
}

export function isEmailFormatValid(emailNormalized: string): boolean {
	if (!emailNormalized || emailNormalized.length > EMAIL_MAX_LENGTH) return false;
	return EMAIL_PATTERN.test(emailNormalized);
}

export function isPasswordFormatValid(password: string): boolean {
	return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

export function sanitizeDisplayName(name: string | null | undefined): string | null {
	if (!name) return null;
	const trimmed = name.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, 80);
}

export function hashPassword(password: string): string {
	const salt = randomBytes(16).toString('hex');
	const hash = scryptSync(password, salt, 64).toString('hex');
	return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
	try {
		const [salt, hash] = storedHash.split(':');
		if (!salt || !hash || hash.length % 2 !== 0) return false;

		const hashToVerify = scryptSync(password, salt, 64).toString('hex');
		const storedBuffer = Buffer.from(hash, 'hex');
		const verifyBuffer = Buffer.from(hashToVerify, 'hex');
		if (storedBuffer.length !== verifyBuffer.length) return false;

		return timingSafeEqual(storedBuffer, verifyBuffer);
	} catch {
		return false;
	}
}
