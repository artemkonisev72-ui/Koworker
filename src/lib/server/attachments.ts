import mammoth from 'mammoth';
import {
	augmentPromptWithAttachments,
	attachmentRenderedImages,
	attachmentsFromStoredRows,
	MAX_ATTACHMENT_TEXT_CHARS,
	normalizeAttachmentInputs,
	serializeRenderedImages,
	truncateAttachmentText,
	validatePreparedAttachments,
	type PreparedAttachment,
	type StoredChatAttachment
} from '$lib/chat/attachments.js';
import type { ChatImage } from '$lib/chat/images.js';

type AttachmentDbRow = {
	kind: 'PDF' | 'DOCX';
	fileName: string;
	mimeType: string;
	sizeBytes: number;
	base64Data: string;
	extractedText: string | null;
	renderedImageData: string | null;
	pageCount: number | null;
	usedPageCount: number | null;
};

export type PreparedMessageAttachments = {
	dbRows: AttachmentDbRow[];
	attachments: StoredChatAttachment[];
	renderedImages: ChatImage[];
	augmentedPrompt: string;
};

function countRawAttachments(input: unknown): number {
	if (input === null || input === undefined) return 0;
	return Array.isArray(input) ? input.length : 1;
}

function decodeBase64(base64Data: string): Buffer {
	return Buffer.from(base64Data, 'base64');
}

async function extractDocxText(attachment: PreparedAttachment): Promise<string> {
	try {
		const result = await mammoth.extractRawText({ buffer: decodeBase64(attachment.base64Data) });
		return truncateAttachmentText(result.value.trim(), MAX_ATTACHMENT_TEXT_CHARS);
	} catch {
		throw new Error(`Не удалось прочитать DOCX-файл "${attachment.fileName}".`);
	}
}

async function prepareAttachment(attachment: PreparedAttachment): Promise<AttachmentDbRow> {
	const renderedImages = attachment.kind === 'PDF' ? attachment.renderedImages : [];
	let extractedText = attachment.extractedText ?? null;

	if (attachment.kind === 'DOCX') {
		extractedText = await extractDocxText(attachment);
		if (!extractedText) {
			throw new Error(`Не удалось извлечь текст из DOCX-файла "${attachment.fileName}".`);
		}
	}

	return {
		kind: attachment.kind,
		fileName: attachment.fileName,
		mimeType: attachment.mimeType,
		sizeBytes: attachment.sizeBytes,
		base64Data: attachment.base64Data,
		extractedText,
		renderedImageData: serializeRenderedImages(renderedImages),
		pageCount: attachment.pageCount,
		usedPageCount: renderedImages.length > 0 ? renderedImages.length : attachment.usedPageCount
	};
}

export async function prepareMessageAttachments(params: {
	rawAttachments: unknown;
	prompt: string;
	existingImageCount?: number;
}): Promise<PreparedMessageAttachments> {
	const normalized = normalizeAttachmentInputs(params.rawAttachments);
	if (countRawAttachments(params.rawAttachments) !== normalized.length) {
		throw new Error('Поддерживаются только PDF и DOCX файлы.');
	}
	const validationError = validatePreparedAttachments(normalized, {
		existingImageCount: params.existingImageCount ?? 0
	});
	if (validationError) {
		throw new Error(validationError);
	}

	const dbRows = await Promise.all(normalized.map(prepareAttachment));
	const attachments = attachmentsFromStoredRows(dbRows);
	const renderedImages = attachmentRenderedImages(attachments);

	return {
		dbRows,
		attachments,
		renderedImages,
		augmentedPrompt: augmentPromptWithAttachments(params.prompt, attachments)
	};
}

export function selectAttachmentFields() {
	return {
		id: true,
		kind: true,
		fileName: true,
		mimeType: true,
		sizeBytes: true,
		extractedText: true,
		renderedImageData: true,
		pageCount: true,
		usedPageCount: true,
		createdAt: true
	} as const;
}
