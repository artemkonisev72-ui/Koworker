import { beforeEach, describe, expect, it, vi } from 'vitest';

const authThrottleBucketMock = vi.hoisted(() => ({
	findUnique: vi.fn(),
	create: vi.fn(),
	update: vi.fn()
}));

const prismaMock = vi.hoisted(() => ({
	$transaction: vi.fn()
}));

vi.mock('./db', () => ({
	prisma: prismaMock
}));

import { enforceAuthRateLimit, resolveClientIp } from './auth-throttle';

beforeEach(() => {
	vi.clearAllMocks();
	authThrottleBucketMock.findUnique.mockResolvedValue(null);
	authThrottleBucketMock.create.mockResolvedValue({});
	prismaMock.$transaction.mockImplementation(async (callback) =>
		callback({
			authThrottleBucket: authThrottleBucketMock
		})
	);
});

function mockEvent(headers: Record<string, string>, fallbackIp = '127.0.0.1') {
	return {
		request: new Request('http://localhost', { headers }),
		getClientAddress: () => fallbackIp
	} as Parameters<typeof resolveClientIp>[0];
}

describe('auth throttle ip resolution', () => {
	it('prefers x-real-ip', () => {
		const event = mockEvent({
			'x-real-ip': '203.0.113.1',
			'x-forwarded-for': '198.51.100.8'
		});
		expect(resolveClientIp(event)).toBe('203.0.113.1');
	});

	it('falls back to first x-forwarded-for value', () => {
		const event = mockEvent({
			'x-forwarded-for': '198.51.100.10, 10.0.0.5'
		});
		expect(resolveClientIp(event)).toBe('198.51.100.10');
	});

	it('falls back to getClientAddress', () => {
		const event = mockEvent({}, '192.0.2.55');
		expect(resolveClientIp(event)).toBe('192.0.2.55');
	});
});

describe('auth throttle password reset action', () => {
	it('applies rate limits to password reset requests', async () => {
		const event = mockEvent({}, '192.0.2.55');

		await expect(enforceAuthRateLimit(event, 'password-reset', 'user@example.com')).resolves.toEqual({
			allowed: true,
			retryAfterSeconds: 0
		});

		expect(authThrottleBucketMock.create).toHaveBeenCalledTimes(3);
		for (const call of authThrottleBucketMock.create.mock.calls) {
			expect(call[0].data.action).toBe('password-reset');
		}
	});
});
