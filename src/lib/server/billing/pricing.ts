import { env } from '$env/dynamic/private';
import { BillingAccessError, type AiProvider, type AiUsage } from './types.js';

const PRICE_DENOMINATOR = 1_000_000n;
const USD_MICROS_PER_USD = 1_000_000;
const TOKENS_PER_MILLION = 1_000_000;

async function getDb() {
	const { prisma } = await import('$lib/server/db.js');
	return prisma as any;
}

export interface PriceInput {
	inputUsdMicrosPerMillion: bigint | number | string;
	outputUsdMicrosPerMillion: bigint | number | string;
	cachedUsdMicrosPerMillion: bigint | number | string;
	reasoningUsdMicrosPerMillion: bigint | number | string;
}

function toBigInt(value: bigint | number | string | null | undefined): bigint {
	if (typeof value === 'bigint') return value;
	if (typeof value === 'number') return BigInt(Math.max(0, Math.floor(value)));
	if (typeof value === 'string' && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return BigInt(Math.max(0, Math.floor(numeric)));
	}
	return 0n;
}

function charge(tokens: number, microsPerMillion: bigint): bigint {
	if (!Number.isFinite(tokens) || tokens <= 0 || microsPerMillion <= 0n) return 0n;
	return (
		(BigInt(Math.floor(tokens)) * microsPerMillion + PRICE_DENOMINATOR - 1n) / PRICE_DENOMINATOR
	);
}

export function calculateUsageCostUsdMicros(usage: AiUsage, price: PriceInput): bigint {
	return (
		charge(usage.inputTokens, toBigInt(price.inputUsdMicrosPerMillion)) +
		charge(usage.outputTokens, toBigInt(price.outputUsdMicrosPerMillion)) +
		charge(usage.cachedInputTokens, toBigInt(price.cachedUsdMicrosPerMillion)) +
		charge(usage.reasoningTokens, toBigInt(price.reasoningUsdMicrosPerMillion))
	);
}

export function isUnpricedBillingAllowed(): boolean {
	const raw = env.AI_BILLING_ALLOW_UNPRICED?.trim().toLowerCase();
	if (raw === 'true' || raw === '1' || raw === 'yes') return true;
	if (raw === 'false' || raw === '0' || raw === 'no') return false;
	return process.env.NODE_ENV !== 'production';
}

export function providerModelFromPreference(preference: string): {
	provider: AiProvider;
	model: string;
} {
	if (preference.startsWith('openrouter:')) {
		return { provider: 'openrouter', model: preference.slice('openrouter:'.length) };
	}
	return { provider: 'gemini', model: preference };
}

export async function getActivePriceSnapshot(provider: AiProvider, model: string, at = new Date()) {
	const db = await getDb();
	return db.aiModelPriceSnapshot.findFirst({
		where: {
			provider,
			model,
			effectiveFrom: { lte: at },
			OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }]
		},
		orderBy: { effectiveFrom: 'desc' }
	});
}

export async function assertProviderModelPriced(
	provider: AiProvider,
	model: string
): Promise<void> {
	const snapshot = await getActivePriceSnapshot(provider, model);
	if (snapshot || isUnpricedBillingAllowed()) return;
	throw new BillingAccessError(
		402,
		'ai_price_missing',
		`Для модели ${provider}:${model} не задан активный тариф. Обновите каталог цен или включите AI_BILLING_ALLOW_UNPRICED в dev-режиме.`
	);
}

export async function resolveUsageCost(usage: AiUsage): Promise<{
	costUsdMicros: bigint;
	priceSnapshotId: string | null;
}> {
	const snapshot = await getActivePriceSnapshot(usage.provider, usage.model);
	if (snapshot) {
		return {
			costUsdMicros: calculateUsageCostUsdMicros(usage, snapshot),
			priceSnapshotId: snapshot.id
		};
	}

	if (!isUnpricedBillingAllowed()) {
		throw new BillingAccessError(
			402,
			'ai_price_missing',
			`Для модели ${usage.provider}:${usage.model} не задан активный тариф.`
		);
	}

	return {
		costUsdMicros:
			typeof usage.providerCostUsdMicros === 'number' &&
			Number.isFinite(usage.providerCostUsdMicros)
				? BigInt(Math.max(0, Math.floor(usage.providerCostUsdMicros)))
				: 0n,
		priceSnapshotId: null
	};
}

export function usdPerTokenToMicrosPerMillion(value: unknown): bigint {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return 0n;
	return BigInt(Math.max(0, Math.round(numeric * TOKENS_PER_MILLION * USD_MICROS_PER_USD)));
}

async function upsertOpenRouterSnapshot(
	model: string,
	pricing: Record<string, unknown>,
	source: string
) {
	const db = await getDb();
	const next = {
		inputUsdMicrosPerMillion: usdPerTokenToMicrosPerMillion(pricing.prompt),
		outputUsdMicrosPerMillion: usdPerTokenToMicrosPerMillion(pricing.completion),
		cachedUsdMicrosPerMillion: usdPerTokenToMicrosPerMillion(pricing.prompt_cache_read),
		reasoningUsdMicrosPerMillion: usdPerTokenToMicrosPerMillion(pricing.reasoning)
	};
	const current = await getActivePriceSnapshot('openrouter', model);
	if (
		current &&
		toBigInt(current.inputUsdMicrosPerMillion) === next.inputUsdMicrosPerMillion &&
		toBigInt(current.outputUsdMicrosPerMillion) === next.outputUsdMicrosPerMillion &&
		toBigInt(current.cachedUsdMicrosPerMillion) === next.cachedUsdMicrosPerMillion &&
		toBigInt(current.reasoningUsdMicrosPerMillion) === next.reasoningUsdMicrosPerMillion
	) {
		return current;
	}

	const now = new Date();
	if (current) {
		await db.aiModelPriceSnapshot.update({
			where: { id: current.id },
			data: { effectiveTo: now }
		});
	}
	return db.aiModelPriceSnapshot.create({
		data: {
			provider: 'openrouter',
			model,
			source,
			...next,
			effectiveFrom: now,
			rawPricing: pricing
		}
	});
}

export async function ensureDefaultPriceSnapshots(): Promise<void> {
	const db = await getDb();
	const freeModels = ['google/gemma-4-31b-it:free'];
	for (const model of freeModels) {
		const current = await getActivePriceSnapshot('openrouter', model);
		if (current) continue;
		await db.aiModelPriceSnapshot.create({
			data: {
				provider: 'openrouter',
				model,
				source: 'default-free-model',
				inputUsdMicrosPerMillion: 0n,
				outputUsdMicrosPerMillion: 0n,
				cachedUsdMicrosPerMillion: 0n,
				reasoningUsdMicrosPerMillion: 0n,
				rawPricing: { free: true }
			}
		});
	}
}

export async function refreshOpenRouterPriceSnapshots(): Promise<{ updated: number }> {
	const baseUrl = (env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(
		/\/+$/,
		''
	);
	const response = await fetch(`${baseUrl}/models`, {
		headers: env.OPENROUTER_API_KEY
			? { Authorization: `Bearer ${env.OPENROUTER_API_KEY.trim()}` }
			: undefined
	});
	if (!response.ok) {
		throw new Error(`OpenRouter models request failed (${response.status})`);
	}
	const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
	let updated = 0;
	for (const entry of payload.data ?? []) {
		const id = typeof entry.id === 'string' ? entry.id : '';
		const pricing = entry.pricing;
		if (!id || !pricing || typeof pricing !== 'object' || Array.isArray(pricing)) continue;
		await upsertOpenRouterSnapshot(id, pricing as Record<string, unknown>, 'openrouter:/models');
		updated += 1;
	}
	return { updated };
}
