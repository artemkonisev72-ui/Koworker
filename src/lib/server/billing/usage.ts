import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { assertProviderModelPriced } from './pricing.js';
import { assertBudgetAfterUsage, assertModelAllowedForActiveContext } from './subscriptions.js';
import type { AiProvider, AiUsage, BillingContext } from './types.js';
import { resolveUsageCost } from './pricing.js';

async function getDb() {
	const { prisma } = await import('$lib/server/db.js');
	return prisma as any;
}

const billingContext = new AsyncLocalStorage<BillingContext>();

export function createBillingPipelineRunId(prefix = 'ai'): string {
	return `${prefix}_${randomUUID()}`;
}

export function getBillingContext(): BillingContext | undefined {
	return billingContext.getStore();
}

export function runWithAiBillingContext<T>(
	context: Omit<BillingContext, 'sequence'> & { sequence?: number },
	fn: () => Promise<T>
): Promise<T> {
	return billingContext.run({ ...context, sequence: context.sequence ?? 0 }, fn);
}

function toJsonSafe(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return { value: String(value) };
	}
}

export async function assertActiveBillingContextCanUseModel(params: {
	provider: AiProvider;
	model: string;
	modelPreference?: string;
}): Promise<void> {
	const context = getBillingContext();
	if (!context) return;
	await assertModelAllowedForActiveContext({
		userId: context.userId,
		modelPreferenceOrProviderModel:
			params.modelPreference ??
			(params.provider === 'openrouter' ? `openrouter:${params.model}` : params.model)
	});
	await assertProviderModelPriced(params.provider, params.model);
}

export async function recordAiUsageEvent(usage: AiUsage): Promise<void> {
	const context = getBillingContext();
	if (!context || usage.provider === 'local') return;

	context.sequence += 1;
	const dedupeKey = `${context.pipelineRunId}:${context.sequence}:${usage.provider}:${usage.model}:${usage.stage}`;
	const { costUsdMicros, priceSnapshotId } = await resolveUsageCost(usage);
	const db = await getDb();

	let usageEvent: any;
	try {
		usageEvent = await db.aiUsageEvent.create({
			data: {
				userId: context.userId,
				chatId: context.chatId ?? undefined,
				messageId: context.messageId ?? undefined,
				draftId: context.draftId ?? undefined,
				provider: usage.provider,
				model: usage.model,
				stage: usage.stage,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedInputTokens: usage.cachedInputTokens,
				reasoningTokens: usage.reasoningTokens,
				totalTokens: usage.totalTokens,
				costUsdMicros,
				priceSnapshotId: priceSnapshotId ?? undefined,
				rawUsage: toJsonSafe(usage.rawUsage),
				pipelineRunId: context.pipelineRunId,
				dedupeKey
			}
		});
	} catch (err) {
		if (
			typeof err === 'object' &&
			err !== null &&
			'code' in err &&
			(err as { code?: string }).code === 'P2002'
		) {
			return;
		}
		throw err;
	}

	await db.billingLedgerEntry.create({
		data: {
			userId: context.userId,
			type: 'AI_USAGE',
			amountUsdMicros: costUsdMicros,
			usageEventId: usageEvent.id,
			metadata: {
				provider: usage.provider,
				model: usage.model,
				stage: usage.stage,
				pipelineRunId: context.pipelineRunId
			}
		}
	});

	await assertBudgetAfterUsage(context.userId);
}
