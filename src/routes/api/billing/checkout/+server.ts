import type { RequestHandler } from './$types';
import { randomUUID } from 'node:crypto';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { getActiveSubscription } from '$lib/server/billing/subscriptions.js';
import { createYooKassaPayment, mapYooKassaStatus } from '$lib/server/billing/yookassa.js';

function toBigInt(value: bigint | number | string): bigint {
	return typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.floor(Number(value) || 0)));
}

export const POST: RequestHandler = async ({ locals, request, url }) => {
	if (!locals.user) return error(401, 'Нужно войти в аккаунт.');

	const body = (await request.json().catch(() => ({}))) as {
		planCode?: string;
		returnUrl?: string;
	};
	const planCode = body.planCode?.trim();
	if (!planCode) return error(400, 'Нужен код тарифа.');

	const db = prisma as any;
	const plan = await db.subscriptionPlan.findFirst({
		where: { code: planCode, isActive: true }
	});
	if (!plan) return error(404, 'Тариф не найден.');
	if (toBigInt(plan.priceRubKopecks) <= 0n)
		return error(400, 'Для бесплатного тарифа оплата не требуется.');

	const subscription = await getActiveSubscription(locals.user.id);
	const idempotenceKey = `checkout_${locals.user.id}_${plan.id}_${randomUUID()}`;
	const localPayment = await db.yooKassaPayment.create({
		data: {
			userId: locals.user.id,
			subscriptionId: subscription.id,
			planId: plan.id,
			idempotenceKey,
			status: 'PENDING',
			amountRubKopecks: plan.priceRubKopecks,
			metadata: {
				kind: 'checkout',
				userId: locals.user.id,
				subscriptionId: subscription.id,
				planId: plan.id,
				planCode: plan.code
			}
		}
	});

	try {
		const remote = await createYooKassaPayment({
			idempotenceKey,
			amountRubKopecks: plan.priceRubKopecks,
			description: `Coworker ${plan.name}`,
			returnUrl: body.returnUrl?.trim() || `${url.origin}/account?billing=return`,
			savePaymentMethod: true,
			metadata: {
				kind: 'checkout',
				localPaymentId: localPayment.id,
				userId: locals.user.id,
				subscriptionId: subscription.id,
				planId: plan.id,
				planCode: plan.code
			}
		});
		const paymentMethodId = remote.payment_method?.id ?? remote.payment_method_id ?? null;
		const updated = await db.yooKassaPayment.update({
			where: { id: localPayment.id },
			data: {
				yooKassaPaymentId: remote.id,
				status: mapYooKassaStatus(remote.status),
				confirmationUrl: remote.confirmation?.confirmation_url ?? null,
				paymentMethodId,
				rawPayload: remote
			}
		});
		return json({
			paymentId: updated.id,
			yooKassaPaymentId: remote.id,
			status: updated.status,
			confirmationUrl: updated.confirmationUrl
		});
	} catch (err) {
		await db.yooKassaPayment.update({
			where: { id: localPayment.id },
			data: {
				status: 'FAILED',
				rawPayload: { error: err instanceof Error ? err.message : String(err) }
			}
		});
		throw err;
	}
};
