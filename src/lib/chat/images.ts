export type ChatImage = {
	base64: string;
	mimeType: string;
};

export const MAX_CHAT_IMAGES = 4;
export const MAX_IMAGE_BASE64_LENGTH = 2_800_000;
export const MAX_TOTAL_IMAGE_BASE64_LENGTH = MAX_CHAT_IMAGES * MAX_IMAGE_BASE64_LENGTH;
export const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function imageOnlyFallbackPrompt(imageCount: number): string {
	return imageCount > 1
		? 'Реши задачу по прикреплённым изображениям. Извлеки все необходимые условия из изображений.'
		: 'Реши задачу по прикреплённому изображению. Извлеки все необходимые условия из изображения.';
}

export function effectivePromptForImages(prompt: string, images: ChatImage[]): string {
	const trimmed = prompt.trim();
	if (trimmed) return trimmed;
	return imageOnlyFallbackPrompt(images.length);
}

export function titleFromPromptOrImages(prompt: string, images: ChatImage[]): string {
	const trimmed = prompt.trim();
	if (trimmed) return trimmed.slice(0, 60) + (trimmed.length > 60 ? '...' : '');
	return images.length > 0 ? 'Задача по изображению' : 'Новый чат';
}

export function normalizeChatImagesInput(input: unknown): ChatImage[] {
	if (input === null || input === undefined) return [];
	const rawItems = Array.isArray(input) ? input : [input];
	return rawItems.map((item) => item as ChatImage);
}

export function normalizeRequestImages(body: { images?: unknown; imageData?: unknown }): ChatImage[] {
	if (body.images !== undefined) return normalizeChatImagesInput(body.images);
	return normalizeChatImagesInput(body.imageData);
}

export function validateChatImages(images: ChatImage[]): string | null {
	if (images.length === 0) return null;
	if (images.length > MAX_CHAT_IMAGES) {
		return `Слишком много изображений. Максимум ${MAX_CHAT_IMAGES}.`;
	}

	let totalBase64Length = 0;
	for (const [index, image] of images.entries()) {
		if (!image || typeof image !== 'object') {
			return `Изображение ${index + 1} некорректно.`;
		}
		if (!ALLOWED_IMAGE_MIME_TYPES.has(image.mimeType)) {
			return `Неподдерживаемый тип изображения ${index + 1}.`;
		}
		if (typeof image.base64 !== 'string' || image.base64.length === 0) {
			return `Изображение ${index + 1} некорректно.`;
		}
		if (image.base64.length > MAX_IMAGE_BASE64_LENGTH) {
			return `Изображение ${index + 1} слишком большое.`;
		}
		totalBase64Length += image.base64.length;
	}

	if (totalBase64Length > MAX_TOTAL_IMAGE_BASE64_LENGTH) {
		return 'Суммарный размер изображений слишком большой.';
	}
	return null;
}

export function hasPromptOrImages(prompt: string, images: ChatImage[]): boolean {
	return prompt.trim().length > 0 || images.length > 0;
}

export function serializeChatImages(images: ChatImage[]): string | null {
	return images.length > 0 ? JSON.stringify(images) : null;
}

export function parseStoredChatImages(value: string | null | undefined): ChatImage[] {
	if (!value) return [];
	try {
		return normalizeChatImagesInput(JSON.parse(value)).filter(
			(image) =>
				image &&
				typeof image === 'object' &&
				typeof image.base64 === 'string' &&
				typeof image.mimeType === 'string'
		);
	} catch {
		return [];
	}
}
