import { describe, expect, it } from 'vitest';
import {
	calculateUsageCostUsdMicros,
	isBudgetFreeProviderModel,
	isProviderModelBudgetExempt,
	resolveUsageCost,
	usdPerTokenToMicrosPerMillion
} from './pricing.ts';
import { includedUsdMicrosFromPaidRubKopecks } from './subscriptions.ts';
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

	it('does not charge direct Gemini 3.1 Flash-lite against AI budget', async () => {
		expect(isBudgetFreeProviderModel('gemini', 'gemini-3.1-flash-lite-preview')).toBe(true);

		const cost = await resolveUsageCost(
			usage({
				model: 'gemini-3.1-flash-lite-preview',
				inputTokens: 10_000,
				outputTokens: 10_000
			})
		);

		expect(cost).toEqual({ costUsdMicros: 0n, priceSnapshotId: null });
	});

	it('treats direct Gemini 3.1 Flash-lite as budget-exempt before DB price lookup', async () => {
		await expect(
			isProviderModelBudgetExempt('gemini', 'gemini-3.1-flash-lite-preview')
		).resolves.toBe(true);
	});

	it('converts 60% of paid RUB subscription amount to USD micros by CBR USD/RUB rate', () => {
		expect(includedUsdMicrosFromPaidRubKopecks(44_900n, 100)).toBe(2_694_000n);
		expect(includedUsdMicrosFromPaidRubKopecks(99_000n, 100)).toBe(5_940_000n);
	});
});
