/**
 * gemini.ts
 * Тонкая обёртка над Gemini API через шлюз ProxyAPI (proxyapi.ru).
 */
import { GEMINI_API_KEY } from '$env/static/private';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

export type GeminiModel =
	| 'gemini-3.1-flash-preview'
	| 'gemini-3.1-pro-preview'
	| 'gemini-3-pro-preview'
	| 'gemini-3-flash-preview'
	| 'gemini-3.1-flash-lite-preview';

const FLASH_CHAIN: GeminiModel[] = [
	'gemini-3.1-flash-preview',
	'gemini-3-flash-preview',
	'gemini-3.1-flash-lite-preview'
];

const PRO_CHAIN: GeminiModel[] = [
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-3.1-flash-preview'
];

const VISION_CHAIN: GeminiModel[] = [
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-3.1-flash-preview'
];

interface GeminiMessage {
	role: 'user' | 'model';
	parts: Array<{
		text?: string;
		inlineData?: {
			mimeType: string;
			data: string;
		};
	}>;
}

async function generate(model: GeminiModel, messages: GeminiMessage[]): Promise<string> {
	// Официальный SDK ожидает contents в camelCase
	const response = await ai.models.generateContent({
		model: model,
		contents: messages,
	});

	if (!response.text) {
		throw new Error(`Gemini API returned empty text (Model: ${model})`);
	}

	return response.text;
}

async function generateWithFallback(
	startModel: GeminiModel,
	chain: GeminiModel[],
	messages: GeminiMessage[],
	forcedModel?: string | null
): Promise<{ text: string; model: GeminiModel }> {
	const effectiveChain = (forcedModel && forcedModel !== 'auto')
		? [forcedModel as GeminiModel]
		: (chain.indexOf(startModel) >= 0 ? chain.slice(chain.indexOf(startModel)) : chain);

	for (let i = 0; i < effectiveChain.length; i++) {
		const model = effectiveChain[i];
		try {
			const text = await generate(model, messages);
			console.log(`[Gemini] Using: ${model}${forcedModel && forcedModel !== 'auto' ? ' (FORCED)' : ''}`);
			return { text, model };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isRetryable = msg.includes('400') || msg.includes('503') || msg.includes('Model not supported');
			if (isRetryable && i < effectiveChain.length - 1) {
				console.warn(`[Gemini] Model ${model} unavailable, falling back...`);
				continue;
			}
			throw err;
		}
	}
	throw new Error(`[Gemini] All models exhausted for ${forcedModel || 'chain'}`);
}

export async function routeQuestion(userMessage: string, forcedModel?: string | null): Promise<{ result: boolean; model: GeminiModel }> {
	const prompt = `Определи, является ли следующий вопрос математической или инженерной задачей. Ответь ТОЛЬКО: YES или NO.\n\nВопрос: ${userMessage}`;
	const { text, model } = await generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, [{ role: 'user', parts: [{ text: prompt }] }], forcedModel);
	return { result: text.trim().toUpperCase().startsWith('YES'), model };
}

export async function generatePythonCode(
	userMessage: string,
	retryContext?: string,
	forcedModel?: string | null
): Promise<{ code: string; model: GeminiModel }> {
	const systemPrompt = `Ты — генератор Python-кода для точных научных вычислений.
ПРАВИЛА:
1. Используй ТОЛЬКО: math, sympy, numpy, json
2. Результат ВСЕГДА выводи через print(json.dumps({...}))
3. Для графиков используй "graphs": [{"title": "...", "type": "function" | "diagram", "points": [{"x":..., "y":...}, ...]}, ...]
   - Используй "type": "diagram" для эпюр (сил, моментов, напряжений) — они будут заштрихованы.
   - Используй "type": "function" для обычных математических функций.
4. Для ответа используй "result"
5. sympy для точности.`;

	let userContent = `Задача: ${userMessage}`;
	if (retryContext) userContent += `\n\nИсправь ошибку:\n${retryContext}`;

	const { text, model } = await generateWithFallback(PRO_CHAIN[0], PRO_CHAIN, [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userContent }] }], forcedModel);
	const codeMatch = text.match(/```python\n([\s\S]*?)```/);
	return { code: codeMatch ? codeMatch[1].trim() : text.trim(), model };
}

export async function assembleFinalAnswer(
	params: { userMessage: string; pythonCode: string; executionResult: string },
	forcedModel?: string | null
): Promise<{ text: string; model: GeminiModel }> {
	const prompt = `Представь решение в академическом виде: Дано / Решение / Ответ.
Используй только эти данные: ${params.executionResult}
Формулы в LaTeX. Не показывай Python-код.\n\nЗадача: ${params.userMessage}`;

	return generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, [{ role: 'user', parts: [{ text: prompt }] }], forcedModel);
}

export async function answerGeneralQuestion(userMessage: string, forcedModel?: string | null): Promise<{ text: string; model: GeminiModel }> {
	const prompt = `Ответь максимально понятно и академично. LaTeX для формул.\n\nВопрос: ${userMessage}`;
	return generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, [{ role: 'user', parts: [{ text: prompt }] }], forcedModel);
}

export async function analyzeImage(base64Data: string, mimeType: string, forcedModel?: string | null): Promise<{ text: string; model: GeminiModel }> {
	const prompt = `Проанализируй изображение. Извлеки условие и опиши схемы для решения.\nОтвет ТОЛЬКО текстом.`;
	const messages: GeminiMessage[] = [{
		role: 'user',
		parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64Data } }]
	}];
	return generateWithFallback(VISION_CHAIN[0], VISION_CHAIN, messages, forcedModel);
}
