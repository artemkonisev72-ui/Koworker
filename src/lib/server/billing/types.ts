export type AiProvider = 'gemini' | 'openrouter' | 'openai' | 'local';

export interface AiUsage {
	provider: AiProvider;
	model: string;
	stage: string;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	rawUsage?: unknown;
	providerCostUsdMicros?: number;
}

export interface BillingContext {
	userId: string;
	chatId?: string | null;
	messageId?: string | null;
	draftId?: string | null;
	pipelineRunId: string;
	sequence: number;
}

export class BillingAccessError extends Error {
	status: number;
	code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'BillingAccessError';
		this.status = status;
		this.code = code;
	}
}

export function normalizeTokenCount(value: unknown): number {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return 0;
	return Math.floor(numeric);
}

export function bigintToNumber(value: bigint | number | string | null | undefined): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : 0;
}

export function bigintToString(value: bigint | number | string | null | undefined): string {
	if (value === null || value === undefined) return '0';
	return value.toString();
}
