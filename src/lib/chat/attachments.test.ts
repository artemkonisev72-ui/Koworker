import { describe, expect, it } from 'vitest';
import {
	DOCX_MIME_TYPE,
	MAX_ATTACHMENT_SIZE_BYTES,
	MAX_CHAT_DOCUMENTS,
	PDF_MIME_TYPE,
	attachmentsFromStoredRows,
	buildAttachmentContext,
	detectAttachmentKind,
	normalizeAttachmentInputs,
	serializeRenderedImages,
	truncateAttachmentText,
	validatePreparedAttachments,
	type ChatAttachmentInput
} from './attachments';

const pdfInput: ChatAttachmentInput = {
	kind: 'PDF',
	fileName: 'task.pdf',
	mimeType: PDF_MIME_TYPE,
	sizeBytes: 1024,
	base64Data: 'AAAA',
	extractedText: 'Условие задачи из PDF',
	renderedImages: [{ base64: 'BBBB', mimeType: 'image/png' }],
	pageCount: 1,
	usedPageCount: 1
};

const docxInput: ChatAttachmentInput = {
	kind: 'DOCX',
	fileName: 'task.docx',
	mimeType: DOCX_MIME_TYPE,
	sizeBytes: 2048,
	base64Data: 'CCCC',
	extractedText: 'Текст DOCX'
};

describe('chat attachment helpers', () => {
	it('detects PDF and DOCX by MIME type or extension', () => {
		expect(detectAttachmentKind('task.pdf', '')).toBe('PDF');
		expect(detectAttachmentKind('task.bin', PDF_MIME_TYPE)).toBe('PDF');
		expect(detectAttachmentKind('task.docx', '')).toBe('DOCX');
		expect(detectAttachmentKind('task.bin', DOCX_MIME_TYPE)).toBe('DOCX');
		expect(detectAttachmentKind('task.txt', 'text/plain')).toBeNull();
	});

	it('normalizes attachment inputs and rendered images', () => {
		expect(normalizeAttachmentInputs([pdfInput, docxInput])).toMatchObject([
			{
				kind: 'PDF',
				fileName: 'task.pdf',
				renderedImages: [{ base64: 'BBBB', mimeType: 'image/png' }]
			},
			{
				kind: 'DOCX',
				fileName: 'task.docx'
			}
		]);
		expect(normalizeAttachmentInputs([{ ...pdfInput, fileName: 'task.txt', mimeType: 'text/plain' }])).toEqual([]);
	});

	it('validates document count, size and complete PDF pages', () => {
		const attachments = normalizeAttachmentInputs([pdfInput, docxInput]);
		expect(validatePreparedAttachments(attachments, { existingImageCount: 1 })).toBeNull();
		expect(
			validatePreparedAttachments(Array.from({ length: MAX_CHAT_DOCUMENTS + 1 }, () => attachments[0]))
		).toContain('не больше');
		expect(validatePreparedAttachments([{ ...attachments[0], sizeBytes: MAX_ATTACHMENT_SIZE_BYTES + 1 }])).toContain(
			'слишком большой'
		);
		expect(validatePreparedAttachments([{ ...attachments[0], pageCount: 2, usedPageCount: 1 }])).toContain(
			'все страницы PDF'
		);
	});

	it('builds AI document context with text and PDF page notes', () => {
		const context = buildAttachmentContext([
			{
				kind: 'PDF',
				fileName: 'task.pdf',
				extractedText: 'Условие задачи',
				pageCount: 5,
				usedPageCount: 2
			}
		]);
		expect(context).toContain('[ATTACHED_DOCUMENTS]');
		expect(context).toContain('Файл: task.pdf');
		expect(context).toContain('PDF-страницы для визуального анализа: 2 из 5.');
		expect(context).toContain('Условие задачи');
	});

	it('truncates long document text and parses stored rendered images', () => {
		expect(truncateAttachmentText('abcdef', 4)).toContain('обрезан');
		const stored = attachmentsFromStoredRows([
			{
				kind: 'PDF',
				fileName: 'task.pdf',
				mimeType: PDF_MIME_TYPE,
				sizeBytes: 1024,
				extractedText: null,
				renderedImageData: serializeRenderedImages([{ base64: 'IMG', mimeType: 'image/png' }])
			}
		]);
		expect(stored[0].renderedImages).toEqual([{ base64: 'IMG', mimeType: 'image/png' }]);
	});
});
