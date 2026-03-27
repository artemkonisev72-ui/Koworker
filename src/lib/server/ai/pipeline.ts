/**
 * pipeline.ts
 * Стейт-машина пайплайна решения задачи.
 *
 * Архитектура (строго по спецификации):
 *   Router (Flash) → CodeGen (Pro) → Sandbox (Pyodide) → [Retry ≤2] → Assembler (Flash)
 *
 * Эмиттит событие на каждом шаге через колбэк onStatus,
 * который SSE-слой транслирует клиенту.
 */
import { routeQuestion, generatePythonCode, assembleFinalAnswer, answerGeneralQuestion } from './gemini.js';
import { workerPool, SandboxError } from '../sandbox/worker-pool.js';

export type PipelineStatus =
	| { type: 'ping' }
	| { type: 'status'; message: string }
	| { type: 'result'; content: string; generatedCode?: string; executionLogs?: string; graphData?: GraphPoint[] }
	| { type: 'error'; message: string };

export interface GraphPoint {
	x: number;
	y: number;
}

interface SandboxOutput {
	result?: unknown;
	graph_points?: GraphPoint[];
	[key: string]: unknown;
}

const MAX_RETRIES = 2;

export async function runPipeline(
	userMessage: string,
	onStatus: (event: PipelineStatus) => void
): Promise<void> {
	try {
		// ── Шаг 1: Маршрутизация (Flash) ─────────────────────────────────────
		onStatus({ type: 'status', message: 'Анализ задачи...' });
		const needsComputation = await routeQuestion(userMessage);

		if (!needsComputation) {
			// Общий вопрос — отвечаем напрямую через Flash
			onStatus({ type: 'status', message: 'Формирование ответа...' });
			const answer = await answerGeneralQuestion(userMessage);
			onStatus({ type: 'result', content: answer });
			return;
		}

		// ── Шаг 2: Генерация кода (Pro) ──────────────────────────────────────
		onStatus({ type: 'status', message: 'Генерация кода решения...' });
		let pythonCode = await generatePythonCode(userMessage);

		// ── Шаг 3: Выполнение в Sandbox + Retry ──────────────────────────────
		let lastError: string | null = null;
		let sandboxOutput: SandboxOutput | null = null;
		let rawStdout = '';

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				onStatus({ type: 'status', message: `Исправление ошибки (попытка ${attempt}/${MAX_RETRIES})...` });
				// Retry: отправляем traceback обратно в Pro для исправления
				pythonCode = await generatePythonCode(userMessage, `Предыдущий код:\n\`\`\`python\n${pythonCode}\n\`\`\`\n\nОшибка:\n${lastError}`);
			}

			onStatus({ type: 'status', message: attempt === 0 ? 'Выполнение вычислений...' : `Выполнение исправленного кода...` });

			try {
				const result = await workerPool.execute(pythonCode);
				rawStdout = result.stdout;

				// JSON Fallback: парсим с защитой от мусора в stdout
				try {
					// Ищем первый валидный JSON-объект в stdout
					const jsonMatch = rawStdout.match(/\{[\s\S]*\}/);
					if (jsonMatch) {
						sandboxOutput = JSON.parse(jsonMatch[0]) as SandboxOutput;
					} else {
						sandboxOutput = { result: rawStdout };
					}
				} catch {
					// Если JSON невалидный — используем raw stdout как результат
					sandboxOutput = { result: rawStdout };
				}

				lastError = null;
				break; // Успех — выходим из цикла retry

			} catch (err) {
				if (err instanceof SandboxError) {
					lastError = err.message;
					if (attempt >= MAX_RETRIES) {
						// Исчерпаны все попытки
						onStatus({
							type: 'error',
							message: `Не удалось выполнить вычисления после ${MAX_RETRIES + 1} попыток:\n${lastError}`
						});
						return;
					}
				} else {
					throw err; // Неожиданная ошибка — пробрасываем
				}
			}
		}

		// ── Шаг 4: Сборка ответа (Flash) ─────────────────────────────────────
		onStatus({ type: 'status', message: 'Формирование ответа...' });

		const executionSummary = sandboxOutput
			? JSON.stringify(sandboxOutput, null, 2)
			: rawStdout;

		const finalAnswer = await assembleFinalAnswer({
			userMessage,
			pythonCode,
			executionResult: executionSummary
		});

		// Извлекаем graphData если есть
		const graphData = sandboxOutput?.graph_points ?? undefined;

		onStatus({
			type: 'result',
			content: finalAnswer,
			generatedCode: pythonCode,
			executionLogs: rawStdout,
			graphData
		});

	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		onStatus({ type: 'error', message: `Внутренняя ошибка: ${message}` });
	}
}
