/**
 * gemini.ts
 * Тонкая обёртка над Gemini API через шлюз ProxyAPI (proxyapi.ru).
 * Flash — маршрутизация и финальная сборка ответа.
 * Pro   — генерация Python-кода.
 */
import { PROXYAPI_API_KEY } from '$env/static/private';

const BASE_URL = 'https://api.proxyapi.ru/google/v1beta/models';

// Доступные модели через ProxyAPI
type GeminiModel = 'gemini-2.0-flash' | 'gemini-2.5-pro-preview-03-25';

interface GeminiMessage {
	role: 'user' | 'model';
	parts: Array<{ text: string }>;
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

// ── Flash: маршрутизация (классифицирует вопрос) ──────────────────────────────
export async function routeQuestion(userMessage: string): Promise<boolean> {
	const prompt = `Определи, является ли следующий вопрос математической или инженерной задачей, требующей точных вычислений (термех, сопромат, матанализ, физика, алгебра, геометрия и т.п.).

Ответь ТОЛЬКО: YES или NO.

Вопрос: ${userMessage}`;

	const response = await generate('gemini-2.0-flash', [{ role: 'user', parts: [{ text: prompt }] }]);
	return response.trim().toUpperCase().startsWith('YES');
}

// ── Pro: генерация Python-кода ────────────────────────────────────────────────
export async function generatePythonCode(userMessage: string, retryContext?: string): Promise<string> {
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

	const response = await generate('gemini-2.5-pro-preview-03-25', messages);

	// Извлекаем код из markdown-блока если присутствует
	const codeMatch = response.match(/```python\n([\s\S]*?)```/);
	return codeMatch ? codeMatch[1].trim() : response.trim();
}

// ── Flash: финальная сборка ответа ───────────────────────────────────────────
export async function assembleFinalAnswer(params: {
	userMessage: string;
	pythonCode: string;
	executionResult: string;
}): Promise<string> {
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

	return generate('gemini-2.0-flash', [{ role: 'user', parts: [{ text: prompt }] }]);
}

// ── Flash: ответ без вычислений (общий вопрос) ────────────────────────────────
export async function answerGeneralQuestion(userMessage: string): Promise<string> {
	const prompt = `Ты — AI-ассистент по точным наукам. Ответь на вопрос пользователя.
Используй LaTeX для формул ($...$ или $$...$$).
Отвечай на русском языке.

Вопрос: ${userMessage}`;

	return generate('gemini-2.0-flash', [{ role: 'user', parts: [{ text: prompt }] }]);
}
