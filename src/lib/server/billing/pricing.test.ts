import { describe, expect, it } from 'vitest';
import { calculateUsageCostUsdMicros, usdPerTokenToMicrosPerMillion } from './pricing.ts';
import type { AiUsage } from './types.ts';

function usage(overrides: Partial<AiUsage>): AiUsage {
	return {
		provider: 'gemini',
		model: 'test-model',
		stage: 'Test',
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		...overrides
	};
}

describe('AI pricing calculations', () => {
	it('charges input, output, cached and reasoning token buckets separately', () => {
		const cost = calculateUsageCostUsdMicros(
			usage({
				inputTokens: 1_000_000,
				outputTokens: 500_000,
				cachedInputTokens: 250_000,
				reasoningTokens: 100_000
			}),
			{
				inputUsdMicrosPerMillion: 1_000_000n,
				outputUsdMicrosPerMillion: 4_000_000n,
				cachedUsdMicrosPerMillion: 100_000n,
				reasoningUsdMicrosPerMillion: 2_000_000n
			}
		);

		expect(cost).toBe(3_225_000n);
	});

	it('rounds tiny fractional charges up to one micro-dollar', () => {
		const cost = calculateUsageCostUsdMicros(usage({ inputTokens: 1 }), {
			inputUsdMicrosPerMillion: 1n,
			outputUsdMicrosPerMillion: 0n,
			cachedUsdMicrosPerMillion: 0n,
			reasoningUsdMicrosPerMillion: 0n
		});

		expect(cost).toBe(1n);
	});

	it('converts OpenRouter USD-per-token strings to USD micros per million tokens', () => {
		expect(usdPerTokenToMicrosPerMillion('0.00000015')).toBe(150_000n);
	});
});
