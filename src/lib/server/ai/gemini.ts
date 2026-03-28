/**
 * gemini.ts
 * Тонкая обёртка над Gemini API через шлюз ProxyAPI (proxyapi.ru).
 */
import { PROXYAPI_API_KEY } from '$env/static/private';

const BASE_URL = 'https://api.proxyapi.ru/google/v1beta/models';

export type GeminiModel =
	| 'gemini-3.1-flash-preview'
	| 'gemini-3.1-pro-preview'
	| 'gemini-3-pro-preview'
	| 'gemini-3-flash-preview';

const FLASH_CHAIN: GeminiModel[] = [
	'gemini-3.1-flash-preview',
	'gemini-3-flash-preview'
];

const PRO_CHAIN: GeminiModel[] = [
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-3.1-flash-preview'
];

const VISION_CHAIN: GeminiModel[] = [
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview'
];

interface GeminiMessage {
	role: 'user' | 'model';
	parts: Array<{
		text?: string;
		inline_data?: {
			mime_type: string;
			data: string;
		};
	}>;
}

interface GeminiResponse {
	candidates: Array<{
		content: { parts: Array<{ text: string }> };
	}>;
}

async function generate(model: GeminiModel, messages: GeminiMessage[]): Promise<string> {
	const url = `${BASE_URL}/${model}:generateContent`;

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${PROXYAPI_API_KEY}`
		},
		body: JSON.stringify({ contents: messages })
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Gemini API error ${res.status}: ${body}`);
	}

	const data = (await res.json()) as GeminiResponse;
	return data.candidates[0]?.content?.parts[0]?.text ?? '';
}

async function generateWithFallback(
	startModel: GeminiModel,
	chain: GeminiModel[],
	messages: GeminiMessage[]
): Promise<{ text: string; model: GeminiModel }> {
	const startIndex = chain.indexOf(startModel);
	const fallbackChain = startIndex >= 0 ? chain.slice(startIndex) : chain;

	for (let i = 0; i < fallbackChain.length; i++) {
		const model = fallbackChain[i];
		try {
			const text = await generate(model, messages);
			console.log(`[Gemini] Using: ${model}`);
			return { text, model };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isRetryable = msg.includes('400') || msg.includes('503') || msg.includes('Model not supported');
			if (isRetryable && i < fallbackChain.length - 1) {
				console.warn(`[Gemini] Model ${model} unavailable, falling back...`);
				continue;
			}
			throw err;
		}
	}
	throw new Error('[Gemini] All models in fallback chain exhausted');
}

export async function routeQuestion(userMessage: string): Promise<{ result: boolean; model: GeminiModel }> {
	const prompt = `Определи, является ли следующий вопрос математической или инженерной задачей, требующей точных вычислений. Ответь ТОЛЬКО: YES или NO.\n\nВопрос: ${userMessage}`;
	const startModel = FLASH_CHAIN[0];
	const { text, model } = await generateWithFallback(startModel, FLASH_CHAIN, [{ role: 'user', parts: [{ text: prompt }] }]);
	return { result: text.trim().toUpperCase().startsWith('YES'), model };
}

export async function generatePythonCode(
	userMessage: string,
	retryContext?: string
): Promise<{ code: string; model: GeminiModel }> {
	const systemPrompt = `Ты — генератор Python-кода для точных научных вычислений.
ПРАВИЛА:
1. Используй ТОЛЬКО: math, sympy, numpy, json
2. Результат ВСЕГДА выводи через print(json.dumps({...}))
3. Для графиков используй "graphs": [{"title": "...", "points": [{"x":..., "y":...}, ...]}, ...]
4. Для ответа используй "result"
5. sympy для точности.`;

	let userContent = `Задача: ${userMessage}`;
	if (retryContext) userContent += `\n\nИсправь ошибку:\n${retryContext}`;

	const { text, model } = await generateWithFallback(PRO_CHAIN[0], PRO_CHAIN, [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userContent }] }]);
	const codeMatch = text.match(/```python\n([\s\S]*?)```/);
	return { code: codeMatch ? codeMatch[1].trim() : text.trim(), model };
}

export async function assembleFinalAnswer(
	params: { userMessage: string; pythonCode: string; executionResult: string }
): Promise<{ text: string; model: GeminiModel }> {
	const prompt = `Представь решение в классическом академическом виде: Дано / Решение / Ответ.
Используй только эти данные: ${params.executionResult}
Формулы в LaTeX. Не показывай Python-код.\n\nЗадача: ${params.userMessage}`;

	return generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, [{ role: 'user', parts: [{ text: prompt }] }]);
}

export async function answerGeneralQuestion(userMessage: string): Promise<{ text: string; model: GeminiModel }> {
	const prompt = `Ответь максимально понятно и академично. LaTeX для формул.\n\nВопрос: ${userMessage}`;
	return generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, [{ role: 'user', parts: [{ text: prompt }] }]);
}

export async function analyzeImage(base64Data: string, mimeType: string): Promise<{ text: string; model: GeminiModel }> {
	const prompt = `Проанализируй изображение. Извлеки условие и опиши схемы для решения.\nОтвет ТОЛЬКО текстом.`;
	const messages: GeminiMessage[] = [{
		role: 'user',
		parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Data } }]
	}];
	return generateWithFallback(VISION_CHAIN[0], VISION_CHAIN, messages);
}
