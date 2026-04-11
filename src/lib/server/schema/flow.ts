import type { GeminiHistory } from '$lib/server/ai/gemini.js';
import { prisma } from '$lib/server/db.js';

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
}): string {
	const lines: string[] = [`Schema draft revision #${params.revisionIndex} is ready for review.`];

	if (params.assumptions.length > 0) {
		lines.push('');
		lines.push('Assumptions:');
		for (const assumption of params.assumptions) {
			lines.push(`- ${assumption}`);
		}
	}

	if (params.ambiguities.length > 0) {
		lines.push('');
		lines.push('Ambiguities to verify:');
		for (const ambiguity of params.ambiguities) {
			lines.push(`- ${ambiguity}`);
		}
	}

	lines.push('');
	lines.push('Please confirm the scheme or request revisions.');
	return lines.join('\n');
}
