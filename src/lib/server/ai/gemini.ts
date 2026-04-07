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
	| 'gemini-3.1-flash-lite-preview'
	| 'gemini-2.5-pro'
	| 'gemini-2.5-flash'
	| 'gemini-2.5-flash-lite';

const FLASH_CHAIN: GeminiModel[] = [
	'gemini-3.1-flash-preview',
	'gemini-3-flash-preview',
	'gemini-2.5-flash',
	'gemini-3.1-flash-lite-preview',
	'gemini-2.5-flash-lite'
];

export interface GeminiHistory {
	role: 'USER' | 'ASSISTANT';
	content: string;
	imageData?: { base64: string; mimeType: string };
}

function buildContext(history: GeminiHistory[], systemPrompt: string, currentQuestion: string): GeminiMessage[] {
	const messages: GeminiMessage[] = history.filter(h => h.content).map((h) => {
		const parts: any[] = [{ text: h.content }];
		if (h.imageData) {
			parts.push({ inlineData: { mimeType: h.imageData.mimeType, data: h.imageData.base64 } });
		}
		return {
			role: h.role === 'USER' ? 'user' : 'model',
			parts
		};
	});

	const finalPromptText = currentQuestion ? `${systemPrompt}\n\n${currentQuestion}` : systemPrompt;
	messages.push({
		role: 'user',
		parts: [{ text: finalPromptText }]
	});

	return messages;
}

const PRO_CHAIN: GeminiModel[] = [
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-2.5-pro',
	'gemini-3.1-flash-preview',
	'gemini-2.5-flash'
];

const VISION_CHAIN: GeminiModel[] = [
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-2.5-pro',
	'gemini-3.1-flash-preview',
	'gemini-2.5-flash'
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

async function generate(model: GeminiModel, messages: GeminiMessage[]): Promise<{ text: string; tokens: number }> {
	// Официальный SDK ожидает contents в camelCase
	const response = await ai.models.generateContent({
		model: model,
		contents: messages,
	});

	if (!response.text) {
		throw new Error(`Gemini API returned empty text (Model: ${model})`);
	}

	return { text: response.text, tokens: response.usageMetadata?.totalTokenCount || 0 };
}

async function generateWithFallback(
	startModel: GeminiModel,
	chain: GeminiModel[],
	messages: GeminiMessage[],
	forcedModel?: string | null
): Promise<{ text: string; model: GeminiModel; tokens: number }> {
	const effectiveChain = (forcedModel && forcedModel !== 'auto')
		? [forcedModel as GeminiModel]
		: (chain.indexOf(startModel) >= 0 ? chain.slice(chain.indexOf(startModel)) : chain);

	for (let i = 0; i < effectiveChain.length; i++) {
		const model = effectiveChain[i];
		try {
			const { text, tokens } = await generate(model, messages);
			console.log(`[Gemini] Using: ${model}${forcedModel && forcedModel !== 'auto' ? ' (FORCED)' : ''}`);
			return { text, model, tokens };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isRetryable = msg.includes('400') || msg.includes('404') || msg.includes('503') || msg.includes('not found') || msg.includes('NOT_FOUND') || msg.includes('Model not supported');
			if (isRetryable && i < effectiveChain.length - 1) {
				console.warn(`[Gemini] Model ${model} unavailable, falling back...`);
				continue;
			}
			throw err;
		}
	}
	throw new Error(`[Gemini] All models exhausted for ${forcedModel || 'chain'}`);
}

export async function routeQuestion(history: GeminiHistory[], userMessage: string, forcedModel?: string | null): Promise<{ result: boolean; model: GeminiModel; tokens: number }> {
	const prompt = `Определи, является ли следующий вопрос математической или инженерной задачей (например, "построить эпюру", "нарисовать график", "найти напряжение" — это инженерная задача YES). Ответь ТОЛЬКО: YES или NO.`;
	const messages = buildContext(history, prompt, `Вопрос: ${userMessage}`);
	const { text, model, tokens } = await generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, messages, forcedModel);
	return { result: text.trim().toUpperCase().startsWith('YES'), model, tokens };
}

export async function generatePythonCode(
	history: GeminiHistory[],
	userMessage: string,
	retryContext?: string,
	forcedModel?: string | null
): Promise<{ code: string; model: GeminiModel; tokens: number }> {
	const systemPrompt = `Ты — генератор Python-кода для точных научных вычислений.
ПРАВИЛА:
1. Используй ТОЛЬКО: math, sympy, numpy, json
2. Результат ВСЕГДА выводи через print(json.dumps({...}))
3. ЗАПРЕЩЕНО рисовать графики и эпюры текстом (ASCII-art, палочками, минусами). За это строгий штраф.
4. Для любых графиков и эпюр ОБЯЗАТЕЛЬНО рассчитывай массивы точек (x, y) и выводи их в JSON в ключ "graphs":
   "graphs": [{"title": "...", "type": "function" | "diagram", "points": [{"x":..., "y":...}, ...]}, ...]
   - "type": "diagram" — строго для инженерных эпюр (они автоматически заштрихуются в интерфейсе и получат знаки +/-)
   - "type": "function" — для обычных функций.
5. Для текстовой результирующей информации используй ключ "result".
6. Используй sympy для математической точности и numpy для массивов (например np.linspace) при построении точек графиков.`;

	let userContent = `Задача: ${userMessage}`;
	if (retryContext) userContent += `\n\nИсправь ошибку:\n${retryContext}`;

	const messages = buildContext(history, systemPrompt, userContent);
	const { text, model, tokens } = await generateWithFallback(PRO_CHAIN[0], PRO_CHAIN, messages, forcedModel);
	const codeMatch = text.match(/```python\n([\s\S]*?)```/);
	return { code: codeMatch ? codeMatch[1].trim() : text.trim(), model, tokens };
}

export async function assembleFinalAnswer(
	history: GeminiHistory[],
	params: { userMessage: string; pythonCode: string; executionResult: string },
	forcedModel?: string | null
): Promise<{ text: string; model: GeminiModel; tokens: number }> {
	const prompt = `Представь решение в академическом виде: Дано / Решение / Ответ.
Используй только эти данные: ${params.executionResult}
Формулы в LaTeX. Не показывай Python-код.`;
	const messages = buildContext(history, prompt, `Задача: ${params.userMessage}`);

	return generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, messages, forcedModel);
}

export async function answerGeneralQuestion(history: GeminiHistory[], userMessage: string, forcedModel?: string | null): Promise<{ text: string; model: GeminiModel; tokens: number }> {
	const prompt = `Ответь максимально понятно и академично. LaTeX для формул.`;
	const messages = buildContext(history, prompt, `Вопрос: ${userMessage}`);
	return generateWithFallback(FLASH_CHAIN[0], FLASH_CHAIN, messages, forcedModel);
}

export async function analyzeImage(history: GeminiHistory[], base64Data: string, mimeType: string, forcedModel?: string | null): Promise<{ text: string; model: GeminiModel; tokens: number }> {
	const prompt = `Проанализируй изображение. Извлеки условие и опиши схемы для решения.\nОтвет ТОЛЬКО текстом.`;
	const messages = buildContext(history, prompt, '');
	messages[messages.length - 1].parts.push({ inlineData: { mimeType: mimeType, data: base64Data } });
	return generateWithFallback(VISION_CHAIN[0], VISION_CHAIN, messages, forcedModel);
}
