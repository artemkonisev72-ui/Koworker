import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import {
	activateSubscriptionFromPayment,
	findDueRenewalSubscriptions,
	markSubscriptionPastDue
} from '$lib/server/billing/subscriptions.js';
import { createYooKassaPayment, mapYooKassaStatus } from '$lib/server/billing/yookassa.js';

function authorized(request: Request): boolean {
	const secret = env.BILLING_CRON_SECRET?.trim();
	if (!secret) return false;
	const auth = request.headers.get('authorization') ?? '';
	const headerSecret = request.headers.get('x-cron-secret') ?? '';
	return auth === `Bearer ${secret}` || headerSecret === secret;
}

async function createLedgerOnce(params: {
	userId: string;
	paymentId: string;
	amountRubKopecks: bigint;
}) {
	const db = prisma as any;
	const existing = await db.billingLedgerEntry.findFirst({
		where: { paymentId: params.paymentId, type: 'SUBSCRIPTION_PAYMENT' },
		select: { id: true }
	});
	if (existing) return;
	await db.billingLedgerEntry.create({
		data: {
			userId: params.userId,
			type: 'SUBSCRIPTION_PAYMENT',
			amountRubKopecks: params.amountRubKopecks,
			paymentId: params.paymentId,
			metadata: { provider: 'yookassa', kind: 'renewal' }
		}
	});
}

export const POST: RequestHandler = async ({ request }) => {
	if (!authorized(request)) return error(401, 'Unauthorized');

	const db = prisma as any;
	const due = await findDueRenewalSubscriptions();
	let attempted = 0;
	let renewed = 0;
	let failed = 0;

	for (const subscription of due) {
		attempted += 1;
		const periodKey = subscription.currentPeriodEnd.toISOString().slice(0, 10);
		const idempotenceKey = `renew_${subscription.id}_${periodKey}`;
		let localPayment = await db.yooKassaPayment.findUnique({ where: { idempotenceKey } });
		if (!localPayment) {
			localPayment = await db.yooKassaPayment.create({
				data: {
					userId: subscription.userId,
					subscriptionId: subscription.id,
					planId: subscription.planId,
					idempotenceKey,
					status: 'PENDING',
					amountRubKopecks: subscription.plan.priceRubKopecks,
					paymentMethodId: subscription.yooKassaPaymentMethodId,
					metadata: {
						kind: 'renewal',
						userId: subscription.userId,
						subscriptionId: subscription.id,
						planId: subscription.planId,
						planCode: subscription.plan.code
					}
				}
			});
		}

		try {
			const remote = await createYooKassaPayment({
				idempotenceKey,
				amountRubKopecks: subscription.plan.priceRubKopecks,
				description: `Coworker ${subscription.plan.name}`,
				paymentMethodId: subscription.yooKassaPaymentMethodId,
				metadata: {
					kind: 'renewal',
					localPaymentId: localPayment.id,
					userId: subscription.userId,
					subscriptionId: subscription.id,
					planId: subscription.planId,
					planCode: subscription.plan.code
				}
			});
			const status = mapYooKassaStatus(remote.status);
			localPayment = await db.yooKassaPayment.update({
				where: { id: localPayment.id },
				data: {
					yooKassaPaymentId: remote.id,
					status,
					rawPayload: remote,
					paidAt: status === 'SUCCEEDED' ? new Date() : null
				}
			});
			if (status === 'SUCCEEDED') {
				await activateSubscriptionFromPayment({
					userId: subscription.userId,
					planId: subscription.planId,
					subscriptionId: subscription.id,
					paymentMethodId: subscription.yooKassaPaymentMethodId
				});
				await createLedgerOnce({
					userId: subscription.userId,
					paymentId: localPayment.id,
					amountRubKopecks: localPayment.amountRubKopecks
				});
				renewed += 1;
			} else {
				await markSubscriptionPastDue(subscription.id);
				failed += 1;
			}
		} catch (err) {
			await db.yooKassaPayment.update({
				where: { id: localPayment.id },
				data: {
					status: 'FAILED',
					rawPayload: { error: err instanceof Error ? err.message : String(err) }
				}
			});
			await markSubscriptionPastDue(subscription.id);
			failed += 1;
		}
	}

	return json({ attempted, renewed, failed });
};
