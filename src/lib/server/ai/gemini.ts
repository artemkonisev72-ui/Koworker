/**
 * gemini.ts
 * Тонкая обёртка над Gemini API через шлюз ProxyAPI (proxyapi.ru).
 * Flash — маршрутизация и финальная сборка ответа.
 * Pro   — генерация Python-кода.
 *
 * Поддерживает автоматический откат на модель ниже при ошибке 400/503.
 */
import { PROXYAPI_API_KEY } from '$env/static/private';

const BASE_URL = 'https://api.proxyapi.ru/google/v1beta/models';

// ── Иерархия моделей (по убыванию качества) ───────────────────────────────
export type GeminiModel =
	| 'gemini-3.1-flash-preview'
	| 'gemini-3.1-pro-preview'
	| 'gemini-3-pro-preview'
	| 'gemini-3-flash-preview';

// Полная цепочка отката
const FLASH_CHAIN: GeminiModel[] = [
	'gemini-3.1-flash-preview',
	'gemini-3-flash-preview'
];

const PRO_CHAIN: GeminiModel[] = [
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-3.1-flash-preview' // Fallback to flash if pro is down
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
			data: string; // base64
		};
	}>;
}

interface GeminiResponse {
	candidates: Array<{
		content: { parts: Array<{ text: string }> };
	}>;
}

// ── Базовый вызов API ──────────────────────────────────────────────────────
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

// ── Вызов с автоматическим откатом ────────────────────────────────────────
async function generateWithFallback(
	startModel: GeminiModel,
	chain: GeminiModel[],
	messages: GeminiMessage[]
): Promise<string> {
	const startIndex = chain.indexOf(startModel);
	const fallbackChain = startIndex >= 0 ? chain.slice(startIndex) : chain;

	for (let i = 0; i < fallbackChain.length; i++) {
		const model = fallbackChain[i];
		try {
			const result = await generate(model, messages);
			if (i > 0) console.log(`[Gemini] Fallback succeeded with: ${model}`);
			else console.log(`[Gemini] Using: ${model}`);
			return result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isRetryable = msg.includes('400') || msg.includes('503') || msg.includes('Model not supported');
			if (isRetryable && i < fallbackChain.length - 1) {
				console.warn(`[Gemini] Model ${model} unavailable, falling back...`);
				continue;
			}
			throw err; // Неожиданная ошибка или исчерпали все варианты
		}
	}
	throw new Error('[Gemini] All models in fallback chain exhausted');
}



// ── Flash: маршрутизация ───────────────────────────────────────────────────
export async function routeQuestion(userMessage: string): Promise<boolean> {
	const prompt = `Определи, является ли следующий вопрос математической или инженерной задачей, требующей точных вычислений (термех, сопромат, матанализ, физика, алгебра, геометрия и т.п.).

Ответь ТОЛЬКО: YES или NO.

Вопрос: ${userMessage}`;


	const startModel = FLASH_CHAIN[0];
	const response = await generateWithFallback(startModel, FLASH_CHAIN, [
		{ role: 'user', parts: [{ text: prompt }] }
	]);
	return response.trim().toUpperCase().startsWith('YES');
}

// ── Pro: генерация Python-кода ─────────────────────────────────────────────
export async function generatePythonCode(
	userMessage: string,
	retryContext?: string
): Promise<string> {
	const systemPrompt = `Ты — генератор Python-кода для точных научных вычислений.
ПРАВИЛА (строго):
1. Используй ТОЛЬКО: math, sympy, numpy, json
2. НЕ ИСПОЛЬЗУЙ: os, sys, subprocess, open, eval, exec, requests
3. Результат ВСЕГДА выводи через print(json.dumps({...}))
4. Для графиков добавляй ключ "graph_points": [{"x": ..., "y": ...}, ...]
5. Для ответа добавляй ключ "result" с числом или строкой LaTeX
6. Код должен быть САМОДОСТАТОЧНЫМ и запускаться без аргументов
7. Используй sympy для символьных вычислений и точных дробей`;

	let userContent = `Задача пользователя: ${userMessage}\n\nСгенерируй Python-код для решения этой задачи.`;

	if (retryContext) {
		userContent += `\n\n--- ИСПРАВЬ ОШИБКУ ---\n${retryContext}\n\nИсправь код и верни корректную версию.`;
	}

	const messages: GeminiMessage[] = [
		{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userContent }] }
	];

	const startModel = PRO_CHAIN[0];
	const response = await generateWithFallback(startModel, PRO_CHAIN, messages);

	// Извлекаем код из markdown-блока если присутствует
	const codeMatch = response.match(/```python\n([\s\S]*?)```/);
	return codeMatch ? codeMatch[1].trim() : response.trim();
}

// ── Flash: финальная сборка ───────────────────────────────────────────────
export async function assembleFinalAnswer(
	params: { userMessage: string; pythonCode: string; executionResult: string }
): Promise<string> {
	const prompt = `Ты — заслуженный преподаватель и инженер по точным наукам. Твоя задача — представить решение задачи в классическом академическом виде.

ТЕКСТ ЗАДАЧИ:
${params.userMessage}

ТОЧНЫЕ ДАННЫЕ ИЗ РАСЧЕТОВ (используй только их):
${params.executionResult}

ИНСТРУКЦИИ ПО ОФОРМЛЕНИЮ (СТРОГО):
1. Оформляй решение в стиле "Дано / Решение / Ответ".
2. В разделе "Решение" подробно опиши каждый шаг, используй физические/математические законы.
3. Все формулы пиши ТОЛЬКО в LaTeX ($...$ для строчных, $$...$$ для выделенных).
4. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО:
   - Показывать или упоминать Python-код.
   - Писать фразы типа "я сгенерировал код", "результаты симуляции", "вычисления показали". Пиши так, будто ты сам вывел эти формулы.
   - Оставлять блоки \`\`\`python.
5. В конце обязательно напиши четкий "Ответ: ..." с единицами измерения.

Пиши на грамотном русском языке в уважительном тоне.`;

	const startModel = FLASH_CHAIN[0];
	return generateWithFallback(startModel, FLASH_CHAIN, [
		{ role: 'user', parts: [{ text: prompt }] }
	]);
}

// ── Flash: ответ без вычислений ────────────────────────────────────────────
export async function answerGeneralQuestion(
	userMessage: string
): Promise<string> {
	const prompt = `Ты — заслуженный преподаватель по точным наукам. Ответь на вопрос или поясни теорию максимально понятно и академично.
Используй LaTeX для всех формул ($...$ или $$...$$).
Пиши на грамотном русском языке.

Вопрос: ${userMessage}`;

	const startModel = FLASH_CHAIN[0];
	return generateWithFallback(startModel, FLASH_CHAIN, [
		{ role: 'user', parts: [{ text: prompt }] }
	]);
}

// ── Vision: анализ изображения ──────────────────────────────────────────────
export async function analyzeImage(
	base64Data: string,
	mimeType: string
): Promise<string> {
	const prompt = `Проанализируй изображение задачи по точным наукам (математика, физика, инженерия).

ИНСТРУКЦИЯ:
1. Извлеки полный текст условия задачи.
2. Если на картинке есть графики, чертежи, схемы или таблицы — опиши их максимально подробно текстом (координаты точек, направления сил, значения в узлах и т.д.), чтобы другая LLM могла решить задачу только по твоему описанию.
3. Если на картинке рукописный текст — расшифруй его.

Твой ответ должен содержать ТОЛЬКО текстовое описание задачи без лишних вступлений.`;

	const messages: GeminiMessage[] = [
		{
			role: 'user',
			parts: [
				{ text: prompt },
				{
					inline_data: {
						mime_type: mimeType,
						data: base64Data
					}
				}
			]
		}
	];

	const startModel = VISION_CHAIN[0];
	return generateWithFallback(startModel, VISION_CHAIN, messages);
}
