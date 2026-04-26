import type { GeminiHistory } from '$lib/server/ai/gemini.js';
import { prisma } from '$lib/server/db.js';
import type { SchemaDataV2 } from '$lib/schema/schema-v2.js';
import { isSchemaDataV2 } from '$lib/schema/schema-v2.js';
import { analyzeSchemaLayoutV2 } from '$lib/schema/layout-v2.js';
import {
	type ChatImage,
	hasPromptOrImages,
	parseStoredChatImages,
	validateChatImages
} from '$lib/chat/images.js';
import {
	detectPromptLanguage as detectPromptLanguageShared,
	type PromptLanguage
} from './language.js';

export { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_BASE64_LENGTH } from '$lib/chat/images.js';

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
export const MAX_REVISION_NOTES_LENGTH = 2_000;

export type InputImageData = ChatImage;
export type InputImagesData = ChatImage[];
export type { PromptLanguage };

export function validateUserPrompt(prompt: string, images: InputImagesData = []): string | null {
	if (!hasPromptOrImages(prompt, images)) return 'message or image is required';
	if (prompt.length > MAX_MESSAGE_LENGTH) return `message is too large (max ${MAX_MESSAGE_LENGTH} chars)`;
	return null;
}

export function validateImageData(imageData?: InputImageData | InputImagesData): string | null {
	return validateChatImages(Array.isArray(imageData) ? imageData : imageData ? [imageData] : []);
}

export function validateRevisionNotes(notes: string): string | null {
	if (!notes.trim()) return 'notes are required';
	if (notes.length > MAX_REVISION_NOTES_LENGTH) {
		return `notes are too large (max ${MAX_REVISION_NOTES_LENGTH} chars)`;
	}
	return null;
}

export function parseImageData(value: string | null | undefined): InputImagesData {
	return parseStoredChatImages(value);
}

export function detectPromptLanguage(text: string): PromptLanguage {
	return detectPromptLanguageShared(text);
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
		images: parseImageData(message.imageData)
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

export function getSchemaRepairIssues(schema: unknown): string[] {
	if (!isSchemaDataV2(schema)) return [];
	const typed = schema as SchemaDataV2;
	const metrics = analyzeSchemaLayoutV2(typed);
	const issues: string[] = [];

	if (metrics.coordCollapseRate > 0.45) {
		issues.push(
			`Coordinates are collapsed (coordCollapseRate=${metrics.coordCollapseRate.toFixed(3)}). Rebuild node placement from topology and member constraints.`
		);
	}
	if (metrics.minElementSeparation < 0.06) {
		issues.push(
			`Elements are too close (minElementSeparation=${metrics.minElementSeparation.toFixed(3)}). Increase separation while preserving connectivity.`
		);
	}
	if (metrics.supportOnMemberRate < 0.95) {
		issues.push(
			`Some supports are not attached to member nodes (supportOnMemberRate=${metrics.supportOnMemberRate.toFixed(3)}). Reattach supports using nodeRefs/attach.`
		);
	}
	if (metrics.loadOnMemberRate < 0.95) {
		issues.push(
			`Some loads are not attached to member nodes (loadOnMemberRate=${metrics.loadOnMemberRate.toFixed(3)}). Reattach loads using nodeRefs/attach.`
		);
	}
	if (metrics.aspectDistortion > 35) {
		issues.push(
			`Aspect distortion is too high (aspectDistortion=${metrics.aspectDistortion.toFixed(3)}). Normalize proportions using constraints/lengths.`
		);
	}

	const constraintTypes = new Set(['bar', 'cable', 'spring', 'damper']);
	let missingConstraintCount = 0;
	for (const object of typed.objects) {
		if (!constraintTypes.has(object.type)) continue;
		const geometry = object.geometry as Record<string, unknown>;
		const hasLength = typeof geometry.length === 'number' && Number.isFinite(geometry.length) && geometry.length > 0;
		const hasAngle = typeof geometry.angleDeg === 'number' && Number.isFinite(geometry.angleDeg);
		const constraints =
			typeof geometry.constraints === 'object' && geometry.constraints !== null
				? (geometry.constraints as Record<string, unknown>)
				: null;
		const hasRelations = Boolean(
			(constraints && Array.isArray(constraints.collinearWith) && constraints.collinearWith.length > 0) ||
			(constraints && Array.isArray(constraints.parallelTo) && constraints.parallelTo.length > 0) ||
			(constraints && Array.isArray(constraints.perpendicularTo) && constraints.perpendicularTo.length > 0) ||
			(constraints && typeof constraints.mirrorOf === 'string' && constraints.mirrorOf.trim())
		);
		if (!hasLength || (!hasAngle && !hasRelations)) {
			missingConstraintCount += 1;
		}
	}
	if (missingConstraintCount > 0) {
		issues.push(
			`${missingConstraintCount} linear members are missing mandatory geometry.length and angle/constraints. Fill these fields.`
		);
	}

	let missingWallSideCount = 0;
	for (const object of typed.objects) {
		if (object.type !== 'fixed_wall') continue;
		const wallSide = (object.geometry as Record<string, unknown>).wallSide;
		if (typeof wallSide !== 'string' || !wallSide.trim()) {
			missingWallSideCount += 1;
		}
	}
	if (missingWallSideCount > 0) {
		issues.push(
			`${missingWallSideCount} fixed_wall objects are missing geometry.wallSide. Add left|right|top|bottom.`
		);
	}

	return issues.slice(0, 6);
}
