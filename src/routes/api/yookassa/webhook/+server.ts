import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { activateSubscriptionFromPayment } from '$lib/server/billing/subscriptions.js';
import { getYooKassaPayment, mapYooKassaStatus } from '$lib/server/billing/yookassa.js';

function paymentMethodId(payload: any): string | null {
	return payload?.payment_method?.id ?? payload?.payment_method_id ?? null;
}

async function createPaymentLedgerOnce(params: {
	userId: string;
	paymentId: string;
	amountRubKopecks: bigint;
	metadata: Record<string, unknown>;
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
			metadata: params.metadata
		}
	});
}

export const POST: RequestHandler = async ({ request }) => {
	const event = (await request.json().catch(() => null)) as any;
	const objectPaymentId = event?.object?.id;
	if (typeof objectPaymentId !== 'string' || objectPaymentId.length === 0) {
		return json({ ok: true, ignored: true });
	}

	const verified = await getYooKassaPayment(objectPaymentId);
	const metadata = (verified.metadata ?? event?.object?.metadata ?? {}) as Record<string, unknown>;
	const localPaymentId =
		typeof metadata.localPaymentId === 'string' ? metadata.localPaymentId : null;
	const db = prisma as any;
	let localPayment = localPaymentId
		? await db.yooKassaPayment.findUnique({ where: { id: localPaymentId } })
		: null;
	if (!localPayment) {
		localPayment = await db.yooKassaPayment.findUnique({
			where: { yooKassaPaymentId: objectPaymentId }
		});
	}
	if (!localPayment) return json({ ok: true, ignored: true });

	const status = mapYooKassaStatus(verified.status);
	const methodId = paymentMethodId(verified);
	localPayment = await db.yooKassaPayment.update({
		where: { id: localPayment.id },
		data: {
			yooKassaPaymentId: verified.id,
			status,
			paymentMethodId: methodId,
			rawPayload: verified,
			paidAt: status === 'SUCCEEDED' ? new Date() : localPayment.paidAt
		}
	});

	if (status === 'SUCCEEDED') {
		const userId = typeof metadata.userId === 'string' ? metadata.userId : localPayment.userId;
		const planId = typeof metadata.planId === 'string' ? metadata.planId : localPayment.planId;
		const subscriptionId =
			typeof metadata.subscriptionId === 'string'
				? metadata.subscriptionId
				: localPayment.subscriptionId;
		if (userId && planId) {
			const subscription = await activateSubscriptionFromPayment({
				userId,
				planId,
				subscriptionId,
				paymentMethodId: methodId
			});
			localPayment = await db.yooKassaPayment.update({
				where: { id: localPayment.id },
				data: {
					subscriptionId: subscription.id,
					paymentMethodId: methodId
				}
			});
			await createPaymentLedgerOnce({
				userId,
				paymentId: localPayment.id,
				amountRubKopecks: localPayment.amountRubKopecks,
				metadata: { provider: 'yookassa', event: event?.event ?? event?.type ?? null }
			});
		}
	}

	return json({ ok: true });
};
