import { describe, expect, it } from 'vitest';
import {
	MAX_CHAT_IMAGES,
	MAX_IMAGE_SIZE_BYTES,
	effectivePromptForImages,
	hasPromptOrImages,
	normalizeRequestImages,
	parseStoredChatImages,
	serializeChatImages,
	titleFromPromptOrImages,
	validateChatImages,
	type ChatImage
} from './images';

const png: ChatImage = { base64: 'AAAA', mimeType: 'image/png' };
const jpg: ChatImage = { base64: 'BBBB', mimeType: 'image/jpeg' };

describe('chat image helpers', () => {
	it('normalizes legacy imageData and new images array', () => {
		expect(normalizeRequestImages({ imageData: png })).toEqual([png]);
		expect(normalizeRequestImages({ images: [png, jpg], imageData: png })).toEqual([png, jpg]);
	});

	it('parses legacy stored object and new stored array', () => {
		expect(parseStoredChatImages(JSON.stringify(png))).toEqual([png]);
		expect(parseStoredChatImages(JSON.stringify([png, jpg]))).toEqual([png, jpg]);
		expect(parseStoredChatImages('not json')).toEqual([]);
	});

	it('serializes empty and non-empty image arrays', () => {
		expect(serializeChatImages([])).toBeNull();
		expect(serializeChatImages([png])).toBe(JSON.stringify([png]));
	});

	it('validates image count, mime and size', () => {
		expect(validateChatImages([png, jpg])).toBeNull();
		expect(validateChatImages(Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => png))).toContain('Слишком много');
		expect(validateChatImages([{ base64: 'CCCC', mimeType: 'image/gif' }])).toContain('Неподдерживаемый');
		expect(validateChatImages([{ base64: '', mimeType: 'image/png' }])).toContain('некорректно');
		expect(MAX_IMAGE_SIZE_BYTES).toBe(10 * 1024 * 1024);
	});

	it('allows image-only prompts and provides fallback text/title', () => {
		expect(hasPromptOrImages('', [])).toBe(false);
		expect(hasPromptOrImages('', [png])).toBe(true);
		expect(effectivePromptForImages('', [png])).toContain('прикреплённому изображению');
		expect(titleFromPromptOrImages('', [png])).toBe('Задача по изображению');
	});
});
