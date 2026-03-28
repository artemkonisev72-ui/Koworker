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
import { workerPool, SandboxError } from '../sandbox/worker-pool.js';

export type PipelineStatus =
	| { type: 'ping' }
	| { type: 'status'; message: string }
	| { type: 'result'; content: string; generatedCode?: string; executionLogs?: string; graphData?: GraphData[]; usedModels?: string[] }
	| { type: 'error'; message: string };

export interface GraphPoint {
	x: number;
	y: number;
}

export interface GraphData {
	title?: string;
	points: GraphPoint[];
}

interface SandboxOutput {
	result?: unknown;
	graph_points?: GraphPoint[]; // Для обратной совместимости
	graphs?: GraphData[];        // Массив нескольких графиков
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
	const usedModelsSet = new Set<string>();

	try {
		// ── Шаг 0: Анализ изображения (Vision) ──────────────────────────────
		if (imageData) {
			console.log('[Pipeline] Analyzing image...');
			onStatus({ type: 'status', message: 'Анализ изображения...' });
			const { text: visionDescription, model: visionModel } = await analyzeImage(imageData.base64, imageData.mimeType);
			usedModelsSet.add(`${visionModel} (Vision)`);
			console.log('[Pipeline] Vision description received from', visionModel);
			
			// Склеиваем описание картинки с текстом пользователя
			currentContext = `[ОПИСАНИЕ ИЗОБРАЖЕНИЯ]:\n${visionDescription}\n\n[ЗАПРОС ПОЛЬЗОВАТЕЛЯ]:\n${userMessage}`;
		}

		// ── Шаг 1: Маршрутизация (Flash) ─────────────────────────────────────
		console.log('[Pipeline] Step 1: routing...');
		onStatus({ type: 'status', message: 'Анализ задачи...' });
		const { result: needsComputation, model: routerModel } = await routeQuestion(currentContext);
		usedModelsSet.add(`${routerModel} (Router)`);
		console.log('[Pipeline] Step 1 done: needsComputation =', needsComputation);

		if (!needsComputation) {
			console.log('[Pipeline] General question — calling answerGeneralQuestion');
			onStatus({ type: 'status', message: 'Формирование ответа...' });
			const { text: answer, model: flashModel } = await answerGeneralQuestion(currentContext);
			usedModelsSet.add(`${flashModel} (Text)`);
			onStatus({ type: 'result', content: answer, usedModels: Array.from(usedModelsSet) });
			return;
		}

		// ── Шаг 2: Генерация кода (Pro) ──────────────────────────────────────
		console.log('[Pipeline] Step 2: generating Python code...');
		onStatus({ type: 'status', message: 'Генерация кода решения...' });
		let { code: pythonCode, model: codeModel } = await generatePythonCode(currentContext);
		usedModelsSet.add(`${codeModel} (CodeGen)`);
		console.log('[Pipeline] Step 2 done, code length:', pythonCode.length);

		// ── Шаг 3: Выполнение в Sandbox + Retry ──────────────────────────────
		let lastError: string | null = null;
		let sandboxOutput: SandboxOutput | null = null;
		let rawStdout = '';

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				console.log(`[Pipeline] Retry ${attempt}/${MAX_RETRIES}, lastError:`, lastError?.slice(0, 200));
				onStatus({ type: 'status', message: `Исправление ошибки (попытка ${attempt}/${MAX_RETRIES})...` });
				const retryRes = await generatePythonCode(
					currentContext,
					`Предыдущий код:\n\`\`\`python\n${pythonCode}\n\`\`\`\n\nОшибка:\n${lastError}`
				);
				pythonCode = retryRes.code;
				usedModelsSet.add(`${retryRes.model} (Fixer)`);
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

		const { text: finalAnswer, model: assembleModel } = await assembleFinalAnswer(
			{ userMessage: currentContext, pythonCode, executionResult: executionSummary }
		);
		usedModelsSet.add(`${assembleModel} (Finalizer)`);
		console.log('[Pipeline] Step 4 done, answer length:', finalAnswer.length);

		let graphData: GraphData[] | undefined = undefined;
		if (sandboxOutput?.graphs) {
			graphData = sandboxOutput.graphs;
		} else if (sandboxOutput?.graph_points) {
			graphData = [{ title: 'График решения', points: sandboxOutput.graph_points }];
		}

		onStatus({
			type: 'result',
			content: finalAnswer,
			generatedCode: pythonCode,
			executionLogs: rawStdout,
			graphData,
			usedModels: Array.from(usedModelsSet)
		});
		console.log('[Pipeline] DONE');

	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[Pipeline] UNCAUGHT ERROR:', err);
		onStatus({ type: 'error', message: `Внутренняя ошибка: ${message}` });
	}
}
