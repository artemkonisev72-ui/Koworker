import {
	DEFAULT_MODEL_PREFERENCE,
	MODEL_PREFERENCE_OPTIONS
} from '$lib/server/ai/model-preference.js';
import { ensureDefaultPriceSnapshots, providerModelFromPreference } from './pricing.js';
import { BillingAccessError, bigintToNumber, bigintToString } from './types.js';

export const FREE_PLAN_CODE = 'free';
export const PRO_PLAN_CODE = 'pro';

const DAY_MS = 24 * 60 * 60 * 1000;
const FREE_MODEL_ALLOWLIST = [
	DEFAULT_MODEL_PREFERENCE,
	'gemini-3.1-flash-preview',
	'gemini-3-flash-preview',
	'gemini-2.5-flash',
	'gemini-2.5-flash-lite',
	'openrouter:google/gemma-4-31b-it:free'
];

async function getDb() {
	const { prisma } = await import('$lib/server/db.js');
	return prisma as any;
}

function addMonth(date: Date): Date {
	const next = new Date(date);
	next.setMonth(next.getMonth() + 1);
	return next;
}

function jsonStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function jsonRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

export async function ensureDefaultPlans(): Promise<void> {
	const db = await getDb();
	await ensureDefaultPriceSnapshots();
	await db.subscriptionPlan.upsert({
		where: { code: FREE_PLAN_CODE },
		update: {
			name: 'Free',
			priceRubKopecks: 0n,
			billingPeriod: 'MONTH',
			includedUsdMicros: 50_000n,
			monthlyRequestLimit: 50,
			modelAllowlist: FREE_MODEL_ALLOWLIST,
			featureFlags: { attachments: true, exports: true, paidModels: false },
			isActive: true
		},
		create: {
			code: FREE_PLAN_CODE,
			name: 'Free',
			priceRubKopecks: 0n,
			billingPeriod: 'MONTH',
			includedUsdMicros: 50_000n,
			monthlyRequestLimit: 50,
			modelAllowlist: FREE_MODEL_ALLOWLIST,
			featureFlags: { attachments: true, exports: true, paidModels: false },
			isActive: true
		}
	});
	await db.subscriptionPlan.upsert({
		where: { code: PRO_PLAN_CODE },
		update: {
			name: 'Pro',
			priceRubKopecks: 99_000n,
			billingPeriod: 'MONTH',
			includedUsdMicros: 2_000_000n,
			monthlyRequestLimit: 1000,
			modelAllowlist: [...MODEL_PREFERENCE_OPTIONS],
			featureFlags: { attachments: true, exports: true, paidModels: true, priority: true },
			isActive: true
		},
		create: {
			code: PRO_PLAN_CODE,
			name: 'Pro',
			priceRubKopecks: 99_000n,
			billingPeriod: 'MONTH',
			includedUsdMicros: 2_000_000n,
			monthlyRequestLimit: 1000,
			modelAllowlist: [...MODEL_PREFERENCE_OPTIONS],
			featureFlags: { attachments: true, exports: true, paidModels: true, priority: true },
			isActive: true
		}
	});
}

async function createFreeSubscription(userId: string) {
	const db = await getDb();
	await ensureDefaultPlans();
	const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: FREE_PLAN_CODE } });
	const now = new Date();
	return db.userSubscription.create({
		data: {
			userId,
			planId: plan.id,
			status: 'ACTIVE',
			currentPeriodStart: now,
			currentPeriodEnd: addMonth(now),
			nextChargeAt: null
		},
		include: { plan: true }
	});
}

export async function getActiveSubscription(userId: string) {
	const db = await getDb();
	await ensureDefaultPlans();
	const now = new Date();
	let subscription = await db.userSubscription.findFirst({
		where: {
			userId,
			OR: [
				{ status: 'ACTIVE', currentPeriodEnd: { gt: now } },
				{ status: 'PAST_DUE', nextChargeAt: { gt: now } }
			]
		},
		orderBy: { currentPeriodEnd: 'desc' },
		include: { plan: true }
	});

	if (subscription) return subscription;

	const latest = await db.userSubscription.findFirst({
		where: { userId },
		orderBy: { currentPeriodEnd: 'desc' },
		include: { plan: true }
	});
	if (latest?.plan?.code === FREE_PLAN_CODE) {
		subscription = await db.userSubscription.update({
			where: { id: latest.id },
			data: {
				status: 'ACTIVE',
				currentPeriodStart: now,
				currentPeriodEnd: addMonth(now),
				cancelAtPeriodEnd: false,
				nextChargeAt: null
			},
			include: { plan: true }
		});
		return subscription;
	}

	return createFreeSubscription(userId);
}

export async function getActivePlans() {
	const db = await getDb();
	await ensureDefaultPlans();
	const plans = await db.subscriptionPlan.findMany({
		where: { isActive: true },
		orderBy: [{ priceRubKopecks: 'asc' }, { code: 'asc' }]
	});
	return plans.map(serializePlan);
}

function serializePlan(plan: any) {
	return {
		id: plan.id,
		code: plan.code,
		name: plan.name,
		priceRubKopecks: bigintToString(plan.priceRubKopecks),
		priceRub: bigintToNumber(plan.priceRubKopecks) / 100,
		billingPeriod: plan.billingPeriod,
		includedUsdMicros: bigintToString(plan.includedUsdMicros),
		includedUsd: bigintToNumber(plan.includedUsdMicros) / 1_000_000,
		monthlyRequestLimit: plan.monthlyRequestLimit,
		modelAllowlist: jsonStringArray(plan.modelAllowlist),
		featureFlags: jsonRecord(plan.featureFlags),
		isActive: plan.isActive
	};
}

export async function getBillingSummary(userId: string) {
	const db = await getDb();
	const subscription = await getActiveSubscription(userId);
	const [usageAggregate, requestRows] = await Promise.all([
		db.aiUsageEvent.aggregate({
			where: {
				userId,
				createdAt: {
					gte: subscription.currentPeriodStart,
					lt: subscription.currentPeriodEnd
				}
			},
			_sum: { costUsdMicros: true }
		}),
		db.aiUsageEvent.findMany({
			where: {
				userId,
				createdAt: {
					gte: subscription.currentPeriodStart,
					lt: subscription.currentPeriodEnd
				}
			},
			distinct: ['pipelineRunId'],
			select: { pipelineRunId: true }
		})
	]);
	const usedUsdMicros = bigintToNumber(usageAggregate._sum.costUsdMicros);
	const includedUsdMicros = bigintToNumber(subscription.plan.includedUsdMicros);
	const remainingUsdMicros = Math.max(0, includedUsdMicros - usedUsdMicros);
	return {
		subscription: {
			id: subscription.id,
			status: subscription.status,
			cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
			currentPeriodStart: subscription.currentPeriodStart,
			currentPeriodEnd: subscription.currentPeriodEnd,
			nextChargeAt: subscription.nextChargeAt,
			plan: serializePlan(subscription.plan)
		},
		usage: {
			usedUsdMicros: usedUsdMicros.toString(),
			usedUsd: usedUsdMicros / 1_000_000,
			includedUsdMicros: includedUsdMicros.toString(),
			includedUsd: includedUsdMicros / 1_000_000,
			remainingUsdMicros: remainingUsdMicros.toString(),
			remainingUsd: remainingUsdMicros / 1_000_000,
			requestCount: requestRows.length,
			monthlyRequestLimit: subscription.plan.monthlyRequestLimit
		}
	};
}

export async function assertCanStartAiRequest(params: {
	userId: string;
	modelPreference: string;
}): Promise<void> {
	const summary = await getBillingSummary(params.userId);
	const allowlist = summary.subscription.plan.modelAllowlist;
	if (allowlist.length > 0 && !allowlist.includes(params.modelPreference)) {
		throw new BillingAccessError(
			403,
			'model_not_in_plan',
			`Модель недоступна на текущем тарифе: ${params.modelPreference}.`
		);
	}

	const limit = summary.usage.monthlyRequestLimit;
	if (typeof limit === 'number' && summary.usage.requestCount >= limit) {
		throw new BillingAccessError(
			429,
			'request_limit_exceeded',
			'Месячный лимит запросов на текущем тарифе исчерпан.'
		);
	}

	if (Number(summary.usage.remainingUsdMicros) <= 0) {
		throw new BillingAccessError(
			402,
			'ai_budget_exceeded',
			'Месячный AI-бюджет текущего тарифа исчерпан.'
		);
	}
}

export async function assertModelAllowedForActiveContext(params: {
	userId: string;
	modelPreferenceOrProviderModel: string;
}): Promise<void> {
	const subscription = await getActiveSubscription(params.userId);
	const allowlist = jsonStringArray(subscription.plan.modelAllowlist);
	if (allowlist.length === 0) return;
	const value = params.modelPreferenceOrProviderModel;
	const providerModel = providerModelFromPreference(value);
	const equivalentPreference =
		providerModel.provider === 'openrouter'
			? `openrouter:${providerModel.model}`
			: providerModel.model;
	if (allowlist.includes(value) || allowlist.includes(equivalentPreference)) return;
	throw new BillingAccessError(
		403,
		'model_not_in_plan',
		`Модель недоступна на текущем тарифе: ${value}.`
	);
}

export async function assertBudgetAfterUsage(userId: string): Promise<void> {
	const summary = await getBillingSummary(userId);
	if (Number(summary.usage.usedUsdMicros) > Number(summary.usage.includedUsdMicros)) {
		throw new BillingAccessError(
			402,
			'ai_budget_exceeded',
			'Месячный AI-бюджет текущего тарифа исчерпан. Последний запрос учтен, следующие запросы остановлены.'
		);
	}
}

export async function activateSubscriptionFromPayment(params: {
	userId: string;
	planId: string;
	subscriptionId?: string | null;
	paymentMethodId?: string | null;
}) {
	const db = await getDb();
	const now = new Date();
	const currentPeriodEnd = addMonth(now);
	const data = {
		planId: params.planId,
		status: 'ACTIVE',
		currentPeriodStart: now,
		currentPeriodEnd,
		cancelAtPeriodEnd: false,
		yooKassaPaymentMethodId: params.paymentMethodId ?? undefined,
		nextChargeAt: currentPeriodEnd
	};
	if (params.subscriptionId) {
		return db.userSubscription.update({
			where: { id: params.subscriptionId },
			data,
			include: { plan: true }
		});
	}
	return db.userSubscription.create({
		data: {
			userId: params.userId,
			...data
		},
		include: { plan: true }
	});
}

export async function cancelCurrentSubscription(userId: string) {
	const db = await getDb();
	const subscription = await getActiveSubscription(userId);
	if (subscription.plan.code === FREE_PLAN_CODE) {
		return subscription;
	}
	return db.userSubscription.update({
		where: { id: subscription.id },
		data: {
			cancelAtPeriodEnd: true,
			nextChargeAt: null
		},
		include: { plan: true }
	});
}

export async function findDueRenewalSubscriptions(now = new Date()) {
	const db = await getDb();
	await ensureDefaultPlans();
	return db.userSubscription.findMany({
		where: {
			status: { in: ['ACTIVE', 'PAST_DUE'] },
			cancelAtPeriodEnd: false,
			yooKassaPaymentMethodId: { not: null },
			nextChargeAt: { lte: now },
			plan: { priceRubKopecks: { gt: 0n } }
		},
		include: { plan: true, user: true }
	});
}

export async function markSubscriptionPastDue(subscriptionId: string) {
	const db = await getDb();
	return db.userSubscription.update({
		where: { id: subscriptionId },
		data: {
			status: 'PAST_DUE',
			nextChargeAt: new Date(Date.now() + 3 * DAY_MS)
		}
	});
}
