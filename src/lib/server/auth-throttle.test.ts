import { describe, expect, it } from 'vitest';
import { resolveClientIp } from './auth-throttle';

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
