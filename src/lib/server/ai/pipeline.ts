/**
 * pipeline.ts
 * Стейт-машина пайплайна решения задачи.
 *
 * Архитектура (строго по спецификации):
 *   Complexity → Router (Flash) → CodeGen (Pro) → Sandbox (Pyodide) → [Retry ≤2] → Assembler (Flash)
 *
 * Модель выбирается автоматически на основе оценки сложности (1-4 tier).
 * При недоступности модели — автоматический откат на модель ниже.
 */
import {
	routeQuestion,
	generatePythonCode,
	assembleFinalAnswer,
	answerGeneralQuestion,
	analyzeImage
} from './gemini.js';
import { assessComplexity } from './complexity.js';
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
	onStatus: (event: PipelineStatus) => void,
	imageData?: { base64: string; mimeType: string }
): Promise<void> {
	console.log('[Pipeline] START message:', userMessage.slice(0, 80));
	let currentContext = userMessage;

	try {
		// ── Шаг 0: Анализ изображения (Vision) ──────────────────────────────
		if (imageData) {
			console.log('[Pipeline] Analyzing image...');
			onStatus({ type: 'status', message: 'Анализ изображения...' });
			const visionDescription = await analyzeImage(imageData.base64, imageData.mimeType);
			console.log('[Pipeline] Vision description received, length:', visionDescription.length);
			
			// Склеиваем описание картинки с текстом пользователя
			currentContext = `[ОПИСАНИЕ ИЗОБРАЖЕНИЯ]:\n${visionDescription}\n\n[ЗАПРОС ПОЛЬЗОВАТЕЛЯ]:\n${userMessage}`;
		}

		// ── Оценка сложности (мгновенно, без LLM) ────────────────────────────
		const complexity = assessComplexity(currentContext);
		console.log(`[Complexity] tier=${complexity.tier} score=${complexity.score} reason="${complexity.reason}"`);
		const tier = complexity.tier;

		// ── Шаг 1: Маршрутизация (Flash) ─────────────────────────────────────
		console.log('[Pipeline] Step 1: routing...');
		onStatus({ type: 'status', message: 'Анализ задачи...' });
		const needsComputation = await routeQuestion(currentContext, tier);
		console.log('[Pipeline] Step 1 done: needsComputation =', needsComputation);

		if (!needsComputation) {
			console.log('[Pipeline] General question — calling answerGeneralQuestion');
			onStatus({ type: 'status', message: 'Формирование ответа...' });
			const answer = await answerGeneralQuestion(currentContext, tier);
			console.log('[Pipeline] General answer received, length:', answer.length);
			onStatus({ type: 'result', content: answer });
			return;
		}

		// ── Шаг 2: Генерация кода (Pro/Flash по tier) ────────────────────────
		console.log('[Pipeline] Step 2: generating Python code...');
		onStatus({ type: 'status', message: 'Генерация кода решения...' });
		let pythonCode = await generatePythonCode(currentContext, tier);
		console.log('[Pipeline] Step 2 done, code length:', pythonCode.length);

		// ── Шаг 3: Выполнение в Sandbox + Retry ──────────────────────────────
		let lastError: string | null = null;
		let sandboxOutput: SandboxOutput | null = null;
		let rawStdout = '';

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				console.log(`[Pipeline] Retry ${attempt}/${MAX_RETRIES}, lastError:`, lastError?.slice(0, 200));
				onStatus({ type: 'status', message: `Исправление ошибки (попытка ${attempt}/${MAX_RETRIES})...` });
				pythonCode = await generatePythonCode(
					currentContext,
					tier,
					`Предыдущий код:\n\`\`\`python\n${pythonCode}\n\`\`\`\n\nОшибка:\n${lastError}`
				);
			}

			console.log(`[Pipeline] Step 3: sandbox execute, attempt ${attempt}`);
			onStatus({
				type: 'status',
				message: attempt === 0 ? 'Выполнение вычислений...' : `Выполнение исправленного кода...`
			});

			try {
				const result = await workerPool.execute(pythonCode);
				rawStdout = result.stdout;
				console.log('[Pipeline] Sandbox OK, stdout:', rawStdout.slice(0, 200));

				try {
					const jsonMatch = rawStdout.match(/\{[\s\S]*\}/);
					if (jsonMatch) {
						sandboxOutput = JSON.parse(jsonMatch[0]) as SandboxOutput;
					} else {
						sandboxOutput = { result: rawStdout };
					}
				} catch {
					sandboxOutput = { result: rawStdout };
				}

				lastError = null;
				break;

			} catch (err) {
				console.error(`[Pipeline] Sandbox error (attempt ${attempt}):`, err);
				if (err instanceof SandboxError) {
					lastError = err.message;
					if (attempt >= MAX_RETRIES) {
						onStatus({
							type: 'error',
							message: `Не удалось выполнить вычисления после ${MAX_RETRIES + 1} попыток:\n${lastError}`
						});
						return;
					}
				} else {
					throw err;
				}
			}
		}

		// ── Шаг 4: Сборка ответа (Flash/Pro по tier) ─────────────────────────
		console.log('[Pipeline] Step 4: assembling final answer...');
		onStatus({ type: 'status', message: 'Формирование ответа...' });

		const executionSummary = sandboxOutput
			? JSON.stringify(sandboxOutput, null, 2)
			: rawStdout;

		const finalAnswer = await assembleFinalAnswer(
			{ userMessage: currentContext, pythonCode, executionResult: executionSummary },
			tier
		);
		console.log('[Pipeline] Step 4 done, answer length:', finalAnswer.length);

		const graphData = sandboxOutput?.graph_points ?? undefined;

		onStatus({
			type: 'result',
			content: finalAnswer,
			generatedCode: pythonCode,
			executionLogs: rawStdout,
			graphData
		});
		console.log('[Pipeline] DONE');

	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[Pipeline] UNCAUGHT ERROR:', err);
		onStatus({ type: 'error', message: `Внутренняя ошибка: ${message}` });
	}
}
