import { describe, expect, it } from 'vitest';
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

describe('auth utils', () => {
	it('normalizes email with trim + NFKC + lower-case', () => {
		expect(normalizeEmail('  User.Name+Tag@Example.COM  ')).toBe('user.name+tag@example.com');
		expect(normalizeEmail('ＥＸＡＭＰＬＥ@ＭＡＩＬ.COM')).toBe('example@mail.com');
	});

	it('validates email format and max length', () => {
		expect(isEmailFormatValid('name@example.com')).toBe(true);
		expect(isEmailFormatValid('missing-at.example.com')).toBe(false);
		expect(isEmailFormatValid('missing-domain@')).toBe(false);
		expect(isEmailFormatValid(`${'a'.repeat(255)}@example.com`)).toBe(false);
	});

	it('enforces password length policy', () => {
		expect(isPasswordFormatValid('short')).toBe(false);
		expect(isPasswordFormatValid('a'.repeat(6))).toBe(true);
		expect(isPasswordFormatValid('a'.repeat(128))).toBe(true);
		expect(isPasswordFormatValid('a'.repeat(129))).toBe(false);
	});

	it('hashes and verifies passwords safely', () => {
		const hash = hashPassword('very-secure-password');
		expect(verifyPassword('very-secure-password', hash)).toBe(true);
		expect(verifyPassword('wrong-password', hash)).toBe(false);
		expect(verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
	});

	it('produces opaque tokens and deterministic token hashes', () => {
		const tokenA = generateOpaqueToken();
		const tokenB = generateOpaqueToken();

		expect(tokenA).not.toBe(tokenB);
		expect(tokenA.length).toBeGreaterThanOrEqual(43);
		expect(hashToken(tokenA)).toHaveLength(64);
		expect(hashToken(tokenA)).toBe(hashToken(tokenA));
	});

	it('sanitizes display names', () => {
		expect(sanitizeDisplayName('  Alice   ')).toBe('Alice');
		expect(sanitizeDisplayName('')).toBeNull();
		expect(sanitizeDisplayName(' '.repeat(8))).toBeNull();
		expect(sanitizeDisplayName('a'.repeat(120))?.length).toBe(80);
	});
});
