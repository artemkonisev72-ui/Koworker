import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { resolveDistributedLoadVisualMetrics } from './distributed-load-visuals.ts';

describe('distributed load visuals', () => {
	it('scales arrow length and generated count from rendered span', () => {
		const short = resolveDistributedLoadVisualMetrics(1);
		const long = resolveDistributedLoadVisualMetrics(7);

		expect(short.arrowLength).toBeGreaterThanOrEqual(0.25);
		expect(short.arrowLength).toBeLessThan(long.arrowLength);
		expect(long.arrowLength).toBeLessThanOrEqual(0.75);
		expect(short.arrowCount).toBeGreaterThanOrEqual(3);
		expect(long.arrowCount).toBeGreaterThan(short.arrowCount);
		expect(long.arrowCount).toBeLessThanOrEqual(12);
	});

	it('honors explicit arrow count with renderer clamp', () => {
		expect(resolveDistributedLoadVisualMetrics(2, 2).arrowCount).toBe(3);
		expect(resolveDistributedLoadVisualMetrics(2, 20).arrowCount).toBe(16);
		expect(resolveDistributedLoadVisualMetrics(2, 6).arrowCount).toBe(6);
	});
});
