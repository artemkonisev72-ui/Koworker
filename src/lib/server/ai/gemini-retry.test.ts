import { describe, expect, it } from 'vitest';
import { classifyGeminiError, computeRetryDelayMs } from './gemini-retry.js';

describe('classifyGeminiError', () => {
	it('marks nested ECONNRESET fetch failure as retryable transient network error', () => {
		const nestedCause = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
		const err = new Error('fetch failed', { cause: nestedCause });
		const classified = classifyGeminiError(err);

		expect(classified.retryable).toBe(true);
		expect(classified.shouldTryNextModel).toBe(true);
		expect(classified.reason).toBe('network_error');
		expect(classified.code).toBe('ECONNRESET');
	});

	it('marks 429 as retryable rate limit', () => {
		const err = Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429 });
		const classified = classifyGeminiError(err);

		expect(classified.retryable).toBe(true);
		expect(classified.reason).toBe('rate_limited');
		expect(classified.status).toBe(429);
	});

	it('marks model-not-found errors as non-retryable for current model with fallback', () => {
		const err = new Error('Model not found for this endpoint');
		const classified = classifyGeminiError(err);

		expect(classified.retryable).toBe(false);
		expect(classified.shouldTryNextModel).toBe(true);
		expect(classified.reason).toBe('model_unavailable');
	});
});

describe('computeRetryDelayMs', () => {
	it('returns increasing bounded delays with jitter', () => {
		const attempt1 = computeRetryDelayMs(1, 100, 1_000);
		const attempt2 = computeRetryDelayMs(2, 100, 1_000);
		const attempt3 = computeRetryDelayMs(3, 100, 1_000);

		expect(attempt1).toBeGreaterThanOrEqual(100);
		expect(attempt1).toBeLessThanOrEqual(125);
		expect(attempt2).toBeGreaterThanOrEqual(200);
		expect(attempt2).toBeLessThanOrEqual(250);
		expect(attempt3).toBeGreaterThanOrEqual(400);
		expect(attempt3).toBeLessThanOrEqual(500);
	});
});
