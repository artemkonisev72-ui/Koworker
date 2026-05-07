import { env } from '$env/dynamic/private';

export interface YooKassaAmount {
	value: string;
	currency: 'RUB';
}

export interface YooKassaPaymentResponse {
	id: string;
	status: string;
	paid?: boolean;
	amount?: YooKassaAmount;
	confirmation?: { type?: string; confirmation_url?: string };
	payment_method?: { id?: string; saved?: boolean };
	payment_method_id?: string;
	metadata?: Record<string, unknown>;
	created_at?: string;
	captured_at?: string;
}

export function formatRubAmount(kopecks: bigint | number | string): string {
	const numeric =
		typeof kopecks === 'bigint' ? kopecks : BigInt(Math.max(0, Math.floor(Number(kopecks) || 0)));
	const rub = numeric / 100n;
	const kop = numeric % 100n;
	return `${rub.toString()}.${kop.toString().padStart(2, '0')}`;
}

function getYooKassaConfig() {
	const shopId = env.YOOKASSA_SHOP_ID?.trim();
	const secretKey = env.YOOKASSA_SECRET_KEY?.trim();
	if (!shopId || !secretKey) {
		throw new Error('YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be configured');
	}
	const baseUrl = (env.YOOKASSA_BASE_URL?.trim() || 'https://api.yookassa.ru/v3').replace(
		/\/+$/,
		''
	);
	return { shopId, secretKey, baseUrl };
}

function authHeader(shopId: string, secretKey: string): string {
	return `Basic ${Buffer.from(`${shopId}:${secretKey}`, 'utf8').toString('base64')}`;
}

async function readYooKassaError(response: Response): Promise<string> {
	try {
		const payload = (await response.json()) as {
			description?: string;
			error?: string;
			parameter?: string;
		};
		return (
			[payload.description, payload.error, payload.parameter].filter(Boolean).join(' ') ||
			response.statusText
		);
	} catch {
		return response.statusText;
	}
}

export function mapYooKassaStatus(status: string | null | undefined) {
	if (status === 'succeeded') return 'SUCCEEDED';
	if (status === 'waiting_for_capture') return 'WAITING_FOR_CAPTURE';
	if (status === 'canceled') return 'CANCELED';
	if (status === 'pending') return 'PENDING';
	return 'FAILED';
}

export async function createYooKassaPayment(params: {
	idempotenceKey: string;
	amountRubKopecks: bigint | number | string;
	description: string;
	metadata: Record<string, unknown>;
	returnUrl?: string;
	paymentMethodId?: string | null;
	savePaymentMethod?: boolean;
}): Promise<YooKassaPaymentResponse> {
	const config = getYooKassaConfig();
	const hasSavedMethod = Boolean(params.paymentMethodId);
	const body: Record<string, unknown> = {
		amount: { value: formatRubAmount(params.amountRubKopecks), currency: 'RUB' },
		capture: true,
		description: params.description,
		metadata: params.metadata
	};
	if (hasSavedMethod) {
		body.payment_method_id = params.paymentMethodId;
	} else {
		body.confirmation = {
			type: 'redirect',
			return_url: params.returnUrl
		};
		body.save_payment_method = params.savePaymentMethod ?? true;
	}

	const response = await fetch(`${config.baseUrl}/payments`, {
		method: 'POST',
		headers: {
			Authorization: authHeader(config.shopId, config.secretKey),
			'Content-Type': 'application/json',
			'Idempotence-Key': params.idempotenceKey
		},
		body: JSON.stringify(body)
	});
	if (!response.ok) {
		throw new Error(
			`YooKassa create payment failed (${response.status}): ${await readYooKassaError(response)}`
		);
	}
	return (await response.json()) as YooKassaPaymentResponse;
}

export async function getYooKassaPayment(paymentId: string): Promise<YooKassaPaymentResponse> {
	const config = getYooKassaConfig();
	const response = await fetch(`${config.baseUrl}/payments/${encodeURIComponent(paymentId)}`, {
		headers: {
			Authorization: authHeader(config.shopId, config.secretKey)
		}
	});
	if (!response.ok) {
		throw new Error(
			`YooKassa get payment failed (${response.status}): ${await readYooKassaError(response)}`
		);
	}
	return (await response.json()) as YooKassaPaymentResponse;
}
