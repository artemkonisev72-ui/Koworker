export interface GeminiErrorClassification {
	retryable: boolean;
	shouldTryNextModel: boolean;
	reason:
		| 'rate_limited'
		| 'service_unavailable'
		| 'network_error'
		| 'timeout'
		| 'model_unavailable'
		| 'unknown';
	code: string | null;
	status: number | null;
}

const NETWORK_ERROR_CODES = new Set([
	'ECONNRESET',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'ENOTFOUND',
	'ECONNREFUSED',
	'EHOSTUNREACH',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectErrorMessagesAndCodes(
	error: unknown,
	maxDepth = 8
): { messages: string[]; codes: string[]; statuses: number[] } {
	const messages: string[] = [];
	const codes: string[] = [];
	const statuses: number[] = [];

	let current: unknown = error;
	let depth = 0;

	while (depth < maxDepth && current !== null && current !== undefined) {
		if (current instanceof Error) {
			if (typeof current.message === 'string' && current.message.trim().length > 0) {
				messages.push(current.message);
			}
			const errorRecord = current as Error & { code?: unknown; status?: unknown; response?: unknown };
			if (typeof errorRecord.code === 'string' && errorRecord.code.trim().length > 0) {
				codes.push(errorRecord.code.trim().toUpperCase());
			}
			if (typeof errorRecord.status === 'number' && Number.isFinite(errorRecord.status)) {
				statuses.push(Math.floor(errorRecord.status));
			}
			const response = isRecord(errorRecord.response) ? errorRecord.response : null;
			if (response && typeof response.status === 'number' && Number.isFinite(response.status)) {
				statuses.push(Math.floor(response.status));
			}
			current = (current as Error & { cause?: unknown }).cause;
			depth += 1;
			continue;
		}

		if (isRecord(current)) {
			const message = current.message;
			const code = current.code;
			const status = current.status;
			const response = isRecord(current.response) ? current.response : null;
			const responseStatus = response?.status;
			if (typeof message === 'string' && message.trim().length > 0) messages.push(message);
			if (typeof code === 'string' && code.trim().length > 0) codes.push(code.trim().toUpperCase());
			if (typeof status === 'number' && Number.isFinite(status)) statuses.push(Math.floor(status));
			if (typeof responseStatus === 'number' && Number.isFinite(responseStatus)) {
				statuses.push(Math.floor(responseStatus));
			}
			current = current.cause;
			depth += 1;
			continue;
		}

		break;
	}

	return { messages, codes, statuses };
}

function extractStatusFromMessages(messages: string[]): number | null {
	for (const msg of messages) {
		const match = msg.match(/\b(4\d{2}|5\d{2})\b/);
		if (!match) continue;
		const status = Number(match[1]);
		if (Number.isFinite(status)) return status;
	}
	return null;
}

export function classifyGeminiError(error: unknown): GeminiErrorClassification {
	const { messages, codes, statuses } = collectErrorMessagesAndCodes(error);
	const combined = messages.join(' | ').toLowerCase();
	const status = statuses[0] ?? extractStatusFromMessages(messages);
	const code = codes[0] ?? null;

	if (status === 429 || combined.includes('429')) {
		return {
			retryable: true,
			shouldTryNextModel: true,
			reason: 'rate_limited',
			code,
			status: 429
		};
	}

	if (status === 503 || combined.includes('503')) {
		return {
			retryable: true,
			shouldTryNextModel: true,
			reason: 'service_unavailable',
			code,
			status: 503
		};
	}

	if (
		code !== null && NETWORK_ERROR_CODES.has(code)
		|| combined.includes('fetch failed')
		|| combined.includes('socket disconnected')
		|| combined.includes('tls connection')
		|| combined.includes('network')
	) {
		return {
			retryable: true,
			shouldTryNextModel: true,
			reason: 'network_error',
			code,
			status
		};
	}

	if (combined.includes('timeout')) {
		return {
			retryable: true,
			shouldTryNextModel: true,
			reason: 'timeout',
			code,
			status
		};
	}

	if (
		status === 404
		|| combined.includes('not found')
		|| combined.includes('model not supported')
		|| combined.includes('model is not supported')
		|| combined.includes('unsupported model')
	) {
		return {
			retryable: false,
			shouldTryNextModel: true,
			reason: 'model_unavailable',
			code,
			status
		};
	}

	if (
		status === 400
		&& (combined.includes('model') || combined.includes('preview'))
		&& (combined.includes('not supported') || combined.includes('not found') || combined.includes('unavailable'))
	) {
		return {
			retryable: false,
			shouldTryNextModel: true,
			reason: 'model_unavailable',
			code,
			status
		};
	}

	return {
		retryable: false,
		shouldTryNextModel: false,
		reason: 'unknown',
		code,
		status
	};
}

export function computeRetryDelayMs(attempt: number, baseMs = 500, maxMs = 4_000): number {
	const safeAttempt = Math.max(1, Math.floor(attempt));
	const expDelay = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
	const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(expDelay * 0.25)));
	return expDelay + jitter;
}

export async function sleepMs(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}
