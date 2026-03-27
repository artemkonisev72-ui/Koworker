/**
 * gemini.ts
 * Тонкая обёртка над Gemini API через шлюз ProxyAPI (proxyapi.ru).
 * Flash — маршрутизация и финальная сборка ответа.
 * Pro   — генерация Python-кода.
 *
 * Поддерживает автоматический откат на модель ниже при ошибке 400/503.
 */
import { PROXYAPI_API_KEY } from '$env/static/private';
import type { ComplexityTier } from './complexity.js';

const BASE_URL = 'https://api.proxyapi.ru/google/v1beta/models';

// ── Иерархия моделей (по убыванию качества) ───────────────────────────────
export type GeminiModel =
	| 'gemini-3.1-flash-preview'
	| 'gemini-3.1-pro-preview'
	| 'gemini-3-pro-preview'
	| 'gemini-3-flash-preview'
	| 'gemini-2.5-pro'
	| 'gemini-2.5-flash'
	| 'gemini-2.5-flash-lite'
	| 'gemini-2.0-flash'
	| 'gemini-2.0-flash-lite';

// Полная цепочка отката от лучшей к запасной
const FLASH_CHAIN: GeminiModel[] = [
	'gemini-3.1-flash-preview',
	'gemini-3-flash-preview',
	'gemini-2.5-flash',
	'gemini-2.5-flash-lite',
	'gemini-2.0-flash',
	'gemini-2.0-flash-lite',
];

const PRO_CHAIN: GeminiModel[] = [
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-2.5-pro',
	'gemini-2.5-flash',
	'gemini-2.0-flash',
	'gemini-2.0-flash-lite',
];

// ── Назначение моделей по сложности ───────────────────────────────────────
// [роутер/сборщик Flash, генератор кода]
const TIER_MODELS: Record<ComplexityTier, { flash: GeminiModel; code: GeminiModel; assemble: GeminiModel }> = {
	1: { flash: 'gemini-2.5-flash-lite', code: 'gemini-2.0-flash',       assemble: 'gemini-2.5-flash-lite' },
	2: { flash: 'gemini-2.5-flash',      code: 'gemini-2.5-flash',       assemble: 'gemini-2.5-flash'      },
	3: { flash: 'gemini-2.5-flash',      code: 'gemini-2.5-pro',         assemble: 'gemini-2.5-flash'      },
	4: { flash: 'gemini-3-flash-preview', code: 'gemini-3.1-pro-preview', assemble: 'gemini-3-pro-preview'  },
};

interface GeminiMessage {
	role: 'user' | 'model';
	parts: Array<{ text: string }>;
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

// ── Экспорт: выбор моделей по tier ────────────────────────────────────────
export function getModelsForTier(tier: ComplexityTier) {
	return TIER_MODELS[tier];
}

// ── Flash: маршрутизация ───────────────────────────────────────────────────
export async function routeQuestion(userMessage: string, tier: ComplexityTier = 2): Promise<boolean> {
	const prompt = `Определи, является ли следующий вопрос математической или инженерной задачей, требующей точных вычислений (термех, сопромат, матанализ, физика, алгебра, геометрия и т.п.).

Ответь ТОЛЬКО: YES или NO.

Вопрос: ${userMessage}`;

	const { flash } = TIER_MODELS[tier];
	const response = await generateWithFallback(flash, FLASH_CHAIN, [
		{ role: 'user', parts: [{ text: prompt }] }
	]);
	return response.trim().toUpperCase().startsWith('YES');
}

// ── Pro: генерация Python-кода ─────────────────────────────────────────────
export async function generatePythonCode(
	userMessage: string,
	tier: ComplexityTier = 2,
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

	const { code } = TIER_MODELS[tier];
	const response = await generateWithFallback(code, PRO_CHAIN, messages);

	// Извлекаем код из markdown-блока если присутствует
	const codeMatch = response.match(/```python\n([\s\S]*?)```/);
	return codeMatch ? codeMatch[1].trim() : response.trim();
}

// ── Flash: финальная сборка ───────────────────────────────────────────────
export async function assembleFinalAnswer(
	params: { userMessage: string; pythonCode: string; executionResult: string },
	tier: ComplexityTier = 2
): Promise<string> {
	const prompt = `Ты — AI-ассистент по точным наукам. Пользователь задал задачу, был сгенерирован Python-код, и получен результат вычислений.

ЗАДАЧА ПОЛЬЗОВАТЕЛЯ:
${params.userMessage}

PYTHON-КОД (выполнен в Wasm-песочнице):
\`\`\`python
${params.pythonCode}
\`\`\`

РЕЗУЛЬТАТ ВЫЧИСЛЕНИЙ (точные числа из Python):
${params.executionResult}

Сформируй подробный ответ на русском языке:
1. Объясни ход решения
2. Покажи ключевые формулы в LaTeX ($...$ или $$...$$)
3. Приведи точный ответ из вычислений (не придумывай числа!)
4. Не повторяй код целиком, только ключевые шаги

ВАЖНО: Числовые значения бери ТОЛЬКО из "РЕЗУЛЬТАТ ВЫЧИСЛЕНИЙ".`;

	const { assemble } = TIER_MODELS[tier];
	return generateWithFallback(assemble, FLASH_CHAIN, [
		{ role: 'user', parts: [{ text: prompt }] }
	]);
}

// ── Flash: ответ без вычислений ────────────────────────────────────────────
export async function answerGeneralQuestion(
	userMessage: string,
	tier: ComplexityTier = 2
): Promise<string> {
	const prompt = `Ты — AI-ассистент по точным наукам. Ответь на вопрос пользователя.
Используй LaTeX для формул ($...$ или $$...$$).
Отвечай на русском языке.

Вопрос: ${userMessage}`;

	const { flash } = TIER_MODELS[tier];
	return generateWithFallback(flash, FLASH_CHAIN, [
		{ role: 'user', parts: [{ text: prompt }] }
	]);
}
