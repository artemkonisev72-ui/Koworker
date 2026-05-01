import {
	ALLOWED_IMAGE_MIME_TYPES,
	MAX_IMAGE_BASE64_LENGTH,
	type ChatImage
} from './images';

export type AttachmentKind = 'PDF' | 'DOCX';

export type ChatAttachmentInput = {
	kind: AttachmentKind;
	fileName: string;
	mimeType: string;
	sizeBytes: number;
	base64Data: string;
	extractedText?: string | null;
	renderedImages?: ChatImage[];
	pageCount?: number | null;
	usedPageCount?: number | null;
};

export type StoredChatAttachment = {
	id?: string;
	kind: AttachmentKind;
	fileName: string;
	mimeType: string;
	sizeBytes: number;
	extractedText?: string | null;
	renderedImages?: ChatImage[];
	pageCount?: number | null;
	usedPageCount?: number | null;
	createdAt?: string | Date | null;
};

export type PreparedAttachment = {
	kind: AttachmentKind;
	fileName: string;
	mimeType: string;
	sizeBytes: number;
	base64Data: string;
	extractedText: string | null;
	renderedImages: ChatImage[];
	pageCount: number | null;
	usedPageCount: number | null;
};

export const MAX_CHAT_DOCUMENTS = 3;
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_SIZE_BYTES = 75 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_CHARS = 100_000;
export const MAX_TOTAL_ATTACHMENT_TEXT_CHARS = 200_000;

export const PDF_MIME_TYPE = 'application/pdf';
export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const PDF_MIME_TYPES = new Set([PDF_MIME_TYPE, 'application/x-pdf']);
const DOCX_MIME_TYPES = new Set([DOCX_MIME_TYPE]);

function cleanFileName(value: unknown): string {
	const raw = typeof value === 'string' ? value.trim() : '';
	const withoutSlashes = raw.replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim();
	return withoutSlashes.slice(0, 180);
}

function normalizeMimeType(value: unknown): string {
	return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function extensionFromName(fileName: string): string {
	const match = /\.([^.]+)$/.exec(fileName.toLowerCase());
	return match?.[1] ?? '';
}

export function detectAttachmentKind(fileName: string, mimeType: string): AttachmentKind | null {
	const normalizedMime = normalizeMimeType(mimeType);
	const extension = extensionFromName(fileName);
	if (PDF_MIME_TYPES.has(normalizedMime) || extension === 'pdf') return 'PDF';
	if (DOCX_MIME_TYPES.has(normalizedMime) || extension === 'docx') return 'DOCX';
	return null;
}

export function isAllowedAttachmentFile(file: Pick<File, 'name' | 'type'>): boolean {
	return detectAttachmentKind(file.name, file.type) !== null;
}

function normalizeText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
	if (!normalized) return null;
	return normalized.slice(0, MAX_ATTACHMENT_TEXT_CHARS);
}

function normalizePositiveInteger(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	const integer = Math.floor(value);
	return integer > 0 ? integer : null;
}

function estimateBase64DecodedBytes(base64Data: string): number {
	const compact = base64Data.replace(/\s/g, '');
	if (!compact) return 0;
	const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function formatWholeMegabytes(sizeBytes: number): number {
	return Math.floor(sizeBytes / (1024 * 1024));
}

export function normalizeAttachmentInput(input: unknown): PreparedAttachment | null {
	if (!input || typeof input !== 'object') return null;
	const item = input as ChatAttachmentInput;
	const fileName = cleanFileName(item.fileName);
	const mimeType = normalizeMimeType(item.mimeType);
	const kind = item.kind ?? detectAttachmentKind(fileName, mimeType);
	const detectedKind = detectAttachmentKind(fileName, mimeType);
	const sizeBytes = normalizePositiveInteger(item.sizeBytes);
	const base64Data = typeof item.base64Data === 'string' ? item.base64Data : '';

	if (!fileName || !kind || kind !== detectedKind || !sizeBytes || !base64Data) return null;

	const renderedImages = Array.isArray(item.renderedImages)
		? item.renderedImages.filter(
				(image): image is ChatImage =>
					Boolean(
						image &&
							typeof image === 'object' &&
							typeof image.base64 === 'string' &&
							image.base64.length > 0 &&
							image.base64.length <= MAX_IMAGE_BASE64_LENGTH &&
							ALLOWED_IMAGE_MIME_TYPES.has(image.mimeType)
					)
			)
		: [];

	return {
		kind,
		fileName,
		mimeType,
		sizeBytes,
		base64Data,
		extractedText: normalizeText(item.extractedText),
		renderedImages,
		pageCount: normalizePositiveInteger(item.pageCount),
		usedPageCount: normalizePositiveInteger(item.usedPageCount)
	};
}

export function normalizeAttachmentInputs(input: unknown): PreparedAttachment[] {
	if (input === null || input === undefined) return [];
	const rawItems = Array.isArray(input) ? input : [input];
	return rawItems
		.map(normalizeAttachmentInput)
		.filter((attachment): attachment is PreparedAttachment => attachment !== null);
}

export function parseStoredRenderedImages(value: string | null | undefined): ChatImage[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(image): image is ChatImage =>
				Boolean(
					image &&
						typeof image === 'object' &&
						typeof (image as ChatImage).base64 === 'string' &&
						typeof (image as ChatImage).mimeType === 'string' &&
						ALLOWED_IMAGE_MIME_TYPES.has((image as ChatImage).mimeType)
				)
		);
	} catch {
		return [];
	}
}

export function serializeRenderedImages(images: ChatImage[]): string | null {
	return images.length > 0 ? JSON.stringify(images) : null;
}

export function validatePreparedAttachments(
	attachments: PreparedAttachment[],
	_options?: { existingImageCount?: number }
): string | null {
	if (attachments.length === 0) return null;
	if (attachments.length > MAX_CHAT_DOCUMENTS) {
		return `Можно прикрепить не больше ${MAX_CHAT_DOCUMENTS} документов.`;
	}

	let totalSize = 0;
	for (const [index, attachment] of attachments.entries()) {
		const decodedSize = estimateBase64DecodedBytes(attachment.base64Data);
		const effectiveSize = Math.max(attachment.sizeBytes, decodedSize);
		if (effectiveSize > MAX_ATTACHMENT_SIZE_BYTES) {
			return `Файл "${attachment.fileName || `#${index + 1}`}" слишком большой. Максимум ${formatWholeMegabytes(MAX_ATTACHMENT_SIZE_BYTES)} МБ.`;
		}
		if (attachment.kind === 'PDF') {
			if (!attachment.pageCount) {
				return `Не удалось определить количество страниц PDF "${attachment.fileName || `#${index + 1}`}".`;
			}
			if (attachment.renderedImages.length !== attachment.pageCount) {
				return `Не удалось подготовить все страницы PDF "${attachment.fileName || `#${index + 1}`}" для анализа. Файл не отправлен.`;
			}
			if (attachment.usedPageCount !== null && attachment.usedPageCount !== attachment.pageCount) {
				return `PDF "${attachment.fileName || `#${index + 1}`}" должен быть отправлен в модель полностью. Файл не отправлен.`;
			}
		}
		totalSize += effectiveSize;
	}

	if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
		return `Суммарный размер документов не должен превышать ${formatWholeMegabytes(MAX_TOTAL_ATTACHMENT_SIZE_BYTES)} МБ.`;
	}

	return null;
}

export function attachmentRenderedImages(attachments: Array<Pick<StoredChatAttachment, 'renderedImages'>>): ChatImage[] {
	return attachments.flatMap((attachment) => attachment.renderedImages ?? []);
}

export function attachmentDisplayType(kind: AttachmentKind): string {
	return kind === 'PDF' ? 'PDF' : 'DOCX';
}

export function formatFileSize(sizeBytes: number): string {
	if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '0 Б';
	if (sizeBytes < 1024) return `${sizeBytes} Б`;
	if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} КБ`;
	return `${(sizeBytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function truncateAttachmentText(text: string, maxChars: number): string {
	if (maxChars <= 0) return '';
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 40)).trimEnd()}\n\n[Текст документа обрезан по лимиту.]`;
}

export function buildAttachmentContext(attachments: Array<Pick<StoredChatAttachment, 'kind' | 'fileName' | 'extractedText' | 'pageCount' | 'usedPageCount'>>): string {
	const relevant = attachments.filter((attachment) => {
		const text = typeof attachment.extractedText === 'string' ? attachment.extractedText.trim() : '';
		return text || (attachment.kind === 'PDF' && (attachment.usedPageCount ?? 0) > 0);
	});
	if (relevant.length === 0) return '';

	let remainingChars = MAX_TOTAL_ATTACHMENT_TEXT_CHARS;
	const sections: string[] = ['[ATTACHED_DOCUMENTS]'];
	for (const attachment of relevant) {
		const text = typeof attachment.extractedText === 'string' ? attachment.extractedText.trim() : '';
		const pageInfo =
			attachment.kind === 'PDF' && attachment.usedPageCount
				? `\nPDF-страницы для визуального анализа: ${attachment.usedPageCount}${attachment.pageCount ? ` из ${attachment.pageCount}` : ''}.`
				: '';
		const available = Math.max(0, remainingChars);
		const clippedText = text ? truncateAttachmentText(text, available) : '';
		remainingChars -= clippedText.length;
		sections.push(
			[
				`Файл: ${attachment.fileName}`,
				`Тип: ${attachmentDisplayType(attachment.kind)}`,
				pageInfo.trim(),
				clippedText ? `Текст документа:\n${clippedText}` : ''
			]
				.filter(Boolean)
				.join('\n')
		);
		if (remainingChars <= 0) break;
	}

	return sections.join('\n\n').trim();
}

export function augmentPromptWithAttachments(prompt: string, attachments: StoredChatAttachment[]): string {
	const context = buildAttachmentContext(attachments);
	if (!context) return prompt;
	const trimmedPrompt = prompt.trim();
	return trimmedPrompt ? `${trimmedPrompt}\n\n${context}` : context;
}

export function attachmentsFromStoredRows(
	rows: Array<{
		id?: string;
		kind: AttachmentKind;
		fileName: string;
		mimeType: string;
		sizeBytes: number;
		extractedText?: string | null;
		renderedImageData?: string | null;
		pageCount?: number | null;
		usedPageCount?: number | null;
		createdAt?: string | Date | null;
	}>
): StoredChatAttachment[] {
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		fileName: row.fileName,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes,
		extractedText: row.extractedText ?? null,
		renderedImages: parseStoredRenderedImages(row.renderedImageData ?? null),
		pageCount: row.pageCount ?? null,
		usedPageCount: row.usedPageCount ?? null,
		createdAt: row.createdAt ?? null
	}));
}
