import type { GeminiHistory } from '$lib/server/ai/gemini.js';
import { prisma } from '$lib/server/db.js';
import type { SchemaDataV2 } from '$lib/schema/schema-v2.js';
import { isSchemaDataV2 } from '$lib/schema/schema-v2.js';
import { analyzeSchemaLayoutV2 } from '$lib/schema/layout-v2.js';

type DraftStatus =
	| 'DRAFT'
	| 'SCHEMA_GENERATED'
	| 'AWAITING_REVIEW'
	| 'NEEDS_REVISION'
	| 'SCHEMA_APPROVED'
	| 'SOLVING'
	| 'SOLVED'
	| 'CANCELED'
	| 'FAILED';

export const MAX_MESSAGE_LENGTH = 8_000;
export const MAX_IMAGE_BASE64_LENGTH = 2_800_000;
export const MAX_REVISION_NOTES_LENGTH = 2_000;
export const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type InputImageData = { base64: string; mimeType: string };
export type PromptLanguage = 'ru' | 'en';

export function validateUserPrompt(prompt: string): string | null {
	if (!prompt.trim()) return 'message is required';
	if (prompt.length > MAX_MESSAGE_LENGTH) return `message is too large (max ${MAX_MESSAGE_LENGTH} chars)`;
	return null;
}

export function validateImageData(imageData?: InputImageData): string | null {
	if (!imageData) return null;
	if (!ALLOWED_IMAGE_MIME_TYPES.has(imageData.mimeType)) {
		return 'Unsupported image mime type';
	}
	if (typeof imageData.base64 !== 'string' || imageData.base64.length > MAX_IMAGE_BASE64_LENGTH) {
		return 'image is too large';
	}
	return null;
}

export function validateRevisionNotes(notes: string): string | null {
	if (!notes.trim()) return 'notes are required';
	if (notes.length > MAX_REVISION_NOTES_LENGTH) {
		return `notes are too large (max ${MAX_REVISION_NOTES_LENGTH} chars)`;
	}
	return null;
}

export function parseImageData(value: string | null | undefined): InputImageData | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as InputImageData;
		if (!parsed || typeof parsed.base64 !== 'string' || typeof parsed.mimeType !== 'string') return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function detectPromptLanguage(text: string): PromptLanguage {
	const cyrillicCount = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
	const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;

	if (cyrillicCount === 0 && latinCount === 0) return 'en';
	return cyrillicCount >= latinCount * 0.6 ? 'ru' : 'en';
}

export async function loadGeminiHistory(chatId: string, take = 20): Promise<GeminiHistory[]> {
	const rawHistory = await prisma.message.findMany({
		where: { chatId },
		orderBy: { createdAt: 'asc' },
		take
	});

	return rawHistory.map((message) => ({
		role: message.role as 'USER' | 'ASSISTANT',
		content: message.content || '',
		imageData: parseImageData(message.imageData)
	}));
}

export function isReviewableStatus(status: DraftStatus): boolean {
	return status === 'AWAITING_REVIEW' || status === 'NEEDS_REVISION' || status === 'SCHEMA_GENERATED';
}

export function canConfirmStatus(status: DraftStatus): boolean {
	return status === 'AWAITING_REVIEW';
}

export function formatSchemaAssistantContent(params: {
	revisionIndex: number;
	assumptions: string[];
	ambiguities: string[];
	language?: PromptLanguage;
}): string {
	const language = params.language ?? 'en';
	const lines: string[] =
		language === 'ru'
			? [`Черновик схемы (ревизия #${params.revisionIndex}) готов к проверке.`]
			: [`Schema draft revision #${params.revisionIndex} is ready for review.`];

	if (params.assumptions.length > 0) {
		lines.push('');
		lines.push(language === 'ru' ? 'Принятые допущения:' : 'Assumptions:');
		for (const assumption of params.assumptions) {
			lines.push(`- ${assumption}`);
		}
	}

	if (params.ambiguities.length > 0) {
		lines.push('');
		lines.push(language === 'ru' ? 'Неоднозначности для проверки:' : 'Ambiguities to verify:');
		for (const ambiguity of params.ambiguities) {
			lines.push(`- ${ambiguity}`);
		}
	}

	lines.push('');
	lines.push(
		language === 'ru'
			? 'Подтвердите схему или отправьте замечания на доработку.'
			: 'Please confirm the scheme or request revisions.'
	);
	return lines.join('\n');
}

function toLogValue(value: unknown): string {
	if (value === null || value === undefined) return '-';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value === 'string') {
		const compact = value.replace(/\s+/g, ' ').trim();
		return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return '[unserializable]';
	}
}

export function logSchemaCheck(event: string, details?: Record<string, unknown>): void {
	if (!details || Object.keys(details).length === 0) {
		console.log(`[SchemaCheck] ${event}`);
		return;
	}

	const line = Object.entries(details)
		.map(([key, value]) => `${key}=${toLogValue(value)}`)
		.join(' | ');
	console.log(`[SchemaCheck] ${event} | ${line}`);
}

export function getSchemaLayoutLogDetails(schema: unknown): Record<string, unknown> | null {
	if (!isSchemaDataV2(schema)) return null;
	const metrics = analyzeSchemaLayoutV2(schema as SchemaDataV2);
	return {
		nodeCount: metrics.nodeCount,
		objectCount: metrics.objectCount,
		edgeCount: metrics.edgeCount,
		outsideViewportRate: Number(metrics.outsideViewportRate.toFixed(4)),
		aspectDistortion: Number(metrics.aspectDistortion.toFixed(4)),
		minElementSeparation: Number(metrics.minElementSeparation.toFixed(4)),
		supportOnMemberRate: Number(metrics.supportOnMemberRate.toFixed(4)),
		loadOnMemberRate: Number(metrics.loadOnMemberRate.toFixed(4)),
		coordCollapseRate: Number(metrics.coordCollapseRate.toFixed(4)),
		bboxWidth: Number(metrics.bbox.width.toFixed(4)),
		bboxHeight: Number(metrics.bbox.height.toFixed(4))
	};
}
