import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { generateContentMock } = vi.hoisted(() => ({
	generateContentMock: vi.fn()
}));

vi.mock('@google/genai', () => ({
	GoogleGenAI: class GoogleGenAIMock {
		models = {
			generateContent: generateContentMock
		};
	}
}));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { analyzeImage, analyzeImages, routeQuestion, routeTaskByRules } from './gemini.ts';

describe('task routing rules', () => {
	it('detects explicit non-CodeGen task families', () => {
		expect(routeTaskByRules('Не решай, только опиши схему')?.kind).toBe('schema_description');
		expect(routeTaskByRules('Создай описание механизма без вычислений')?.requiresCodeGen).toBe(false);
		expect(routeTaskByRules('Сделай выжимку из PDF')?.kind).toBe('summary');
		expect(routeTaskByRules('Заполни отчет по лабораторной работе')?.kind).toBe('document_transform');
		expect(routeTaskByRules('Напиши сочинение по теме из файла')?.kind).toBe('writing');
	});

	it('keeps explicit answer-only solve requests eligible for CodeGen', () => {
		const route = routeTaskByRules('Не нужно подробное решение, только ответ: найди реакции опор');
		expect(route?.kind).toBe('solve_computation');
		expect(route?.requiresCodeGen).toBe(true);
	});

	it('does not let mathematical document text override a summary request', () => {
		const route = routeTaskByRules(
			'Сделай выжимку из PDF\n\n[ATTACHED_DOCUMENTS]\nФайл: lab.pdf\nТекст документа:\nНайти реакции опор балки.'
		);
		expect(route?.kind).toBe('summary');
		expect(route?.requiresCodeGen).toBe(false);
	});
});

describe('openrouter integration in gemini gateway', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		generateContentMock.mockReset();
		process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
		process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
		process.env.OPENROUTER_HTTP_REFERER = 'http://localhost:5173';
		process.env.OPENROUTER_TITLE = 'Coworker Test';
		process.env.OPENROUTER_REQUEST_TIMEOUT_MS = '60000';
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('sends chat completion request to OpenRouter with proper headers and parses usage', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					model: 'google/gemini-3.1-pro-preview',
					choices: [
						{
							message: {
								content: '{"kind":"solve_computation","confidence":0.95,"reason":"asks to compute"}'
							}
						}
					],
					usage: { total_tokens: 321 }
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await routeQuestion(
			[],
			'Нужно ли выполнять вычисления?',
			'openrouter:google/gemini-3.1-pro-preview'
		);

		expect(result.result).toBe(true);
		expect(result.model).toBe('google/gemini-3.1-pro-preview');
		expect(result.tokens).toBe(321);
		expect(generateContentMock).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
		expect(init.method).toBe('POST');

		const headers = (init.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer test-openrouter-key');
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['HTTP-Referer']).toBe('http://localhost:5173');
		expect(headers['X-OpenRouter-Title']).toBe('Coworker Test');

		const body = JSON.parse(String(init.body)) as {
			model: string;
			messages: Array<{ role: string; content: unknown }>;
		};
		expect(body.model).toBe('google/gemini-3.1-pro-preview');
		expect(Array.isArray(body.messages)).toBe(true);
		expect(body.messages.length).toBeGreaterThan(0);
		expect(body.messages[body.messages.length - 1].role).toBe('user');
	});

	it('encodes image input as OpenRouter image_url content part', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					model: 'google/gemini-3.1-flash-lite-preview',
					choices: [{ message: { content: 'Extracted text' } }],
					usage: { total_tokens: 55 }
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		await analyzeImage(
			[],
			'AAAABBBBCCCC',
			'image/png',
			'openrouter:google/gemini-3.1-flash-lite-preview'
		);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(String(init.body)) as {
			messages: Array<{ role: string; content: unknown }>;
		};
		const lastMessage = body.messages[body.messages.length - 1];
		expect(lastMessage.role).toBe('user');
		expect(Array.isArray(lastMessage.content)).toBe(true);
		const contentParts = lastMessage.content as Array<Record<string, unknown>>;
		const imagePart = contentParts.find((part) => part.type === 'image_url');
		expect(imagePart).toBeTruthy();
		expect((imagePart?.image_url as { url?: string } | undefined)?.url).toBe(
			'data:image/png;base64,AAAABBBBCCCC'
		);
	});

	it('encodes multiple image inputs as multiple OpenRouter image_url content parts', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					model: 'google/gemini-3.1-flash-lite-preview',
					choices: [{ message: { content: 'Extracted text' } }],
					usage: { total_tokens: 77 }
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		await analyzeImages(
			[],
			[
				{ base64: 'FIRST', mimeType: 'image/png' },
				{ base64: 'SECOND', mimeType: 'image/jpeg' }
			],
			'openrouter:google/gemini-3.1-flash-lite-preview'
		);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(String(init.body)) as {
			messages: Array<{ role: string; content: unknown }>;
		};
		const lastMessage = body.messages[body.messages.length - 1];
		expect(Array.isArray(lastMessage.content)).toBe(true);
		const contentParts = lastMessage.content as Array<Record<string, unknown>>;
		const imageParts = contentParts.filter((part) => part.type === 'image_url');
		expect(imageParts).toHaveLength(2);
		expect((imageParts[0].image_url as { url?: string }).url).toBe('data:image/png;base64,FIRST');
		expect((imageParts[1].image_url as { url?: string }).url).toBe('data:image/jpeg;base64,SECOND');
	});

	it('uses a direct Google model preference as preferred model, not a single-model dead end', async () => {
		generateContentMock
			.mockRejectedValueOnce(new Error('Gemini API request failed (503): model overloaded'))
			.mockResolvedValueOnce({
				text: '{"kind":"solve_computation","confidence":0.95,"reason":"asks to compute"}',
				usageMetadata: { totalTokenCount: 42 }
			});

		const result = await routeQuestion(
			[],
			'Это нужно считать?',
			'gemini-3.1-flash-lite-preview'
		);

		expect(result.result).toBe(true);
		expect(result.tokens).toBe(42);
		expect(generateContentMock).toHaveBeenCalledTimes(2);
		expect(generateContentMock.mock.calls[0]?.[0]?.model).toBe('gemini-3.1-flash-lite-preview');
		expect(generateContentMock.mock.calls[1]?.[0]?.model).toBe('gemini-3.1-flash-preview');
	});

	it('fails fast on OpenRouter error without falling back to Google', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: { message: 'provider unavailable' } }), {
				status: 503,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			routeQuestion([], 'Это нужно считать?', 'openrouter:google/gemini-3.1-pro-preview')
		).rejects.toThrow(/OpenRouter API request failed \(503\)/);
		expect(generateContentMock).not.toHaveBeenCalled();
	});
});
