import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	routeTaskMock,
	routeTaskByRulesMock,
	routeApprovedFollowupMock,
	answerGeneralQuestionMock,
	answerNonComputationalTaskMock,
	analyzeImagesMock,
	generatePythonCodeMock,
	assembleFinalAnswerMock,
	generateResultSchemaPatchMock
} = vi.hoisted(() => ({
	routeTaskMock: vi.fn(),
	routeTaskByRulesMock: vi.fn(),
	routeApprovedFollowupMock: vi.fn(),
	answerGeneralQuestionMock: vi.fn(),
	answerNonComputationalTaskMock: vi.fn(),
	analyzeImagesMock: vi.fn(),
	generatePythonCodeMock: vi.fn(),
	assembleFinalAnswerMock: vi.fn(),
	generateResultSchemaPatchMock: vi.fn()
}));

vi.mock('./gemini.ts', () => ({
	routeTask: routeTaskMock,
	routeTaskByRules: routeTaskByRulesMock,
	routeApprovedFollowup: routeApprovedFollowupMock,
	answerGeneralQuestion: answerGeneralQuestionMock,
	answerNonComputationalTask: answerNonComputationalTaskMock,
	analyzeImages: analyzeImagesMock,
	generatePythonCode: generatePythonCodeMock,
	assembleFinalAnswer: assembleFinalAnswerMock,
	generateResultSchemaPatch: generateResultSchemaPatchMock
}));

vi.mock('../sandbox/worker-pool.js', () => ({
	workerPool: {
		execute: vi.fn()
	},
	SandboxError: class SandboxError extends Error {}
}));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { runPipeline, runPipelineWithApprovedSchema } from './pipeline.ts';

function makeApprovedSchema(): any {
	return {
		version: '2.0',
		nodes: [
			{ id: 'A', x: 0, y: 0 },
			{ id: 'B', x: 4, y: 0 }
		],
		objects: [
			{
				id: 'bar_1',
				type: 'bar',
				nodeRefs: ['A', 'B'],
				geometry: { length: 4, angleDeg: 0 }
			}
		],
		results: [],
		annotations: [],
		assumptions: [],
		ambiguities: []
	};
}

function makeSolveStdout() {
	return JSON.stringify({
		version: 'solve-artifacts-1.0',
		exactAnswers: [
			{
				id: 'v_B',
				label: 'Velocity B',
				valueText: '2',
				numericValue: 2,
				unit: 'm/s',
				targetKind: 'support',
				targetId: 'B',
				component: 'v'
			}
		],
		graphData: [
			{
				title: 'v(t)',
				type: 'function',
				points: [
					{ x: 0, y: 0 },
					{ x: 1, y: 2 }
				]
			}
		]
	});
}

describe('runPipeline status sink', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		routeTaskByRulesMock.mockReturnValue(null);
	});

	it('awaits async status callbacks before continuing pipeline steps', async () => {
		let stage = 'initial';

		routeTaskMock.mockImplementation(async () => {
			expect(stage).toBe('route-status-finished');
			return {
				kind: 'general_answer',
				requiresCodeGen: false,
				confidence: 0.8,
				source: 'model',
				model: 'router-test',
				tokens: 12
			};
		});

		answerNonComputationalTaskMock.mockImplementation(async () => {
			expect(stage).toBe('final-status-finished');
			return {
				text: 'ok',
				model: 'text-test',
				tokens: 7
			};
		});

		await runPipeline('test message', [], async (event) => {
			if (event.type === 'status' && event.message === 'Анализирую запрос...') {
				await Promise.resolve();
				stage = 'route-status-finished';
			}
			if (event.type === 'status' && event.message === 'Формирую ответ...') {
				await Promise.resolve();
				stage = 'final-status-finished';
			}
		});

		expect(routeTaskMock).toHaveBeenCalledTimes(1);
		expect(answerNonComputationalTaskMock).toHaveBeenCalledTimes(1);
	});

	it('uses an internal fallback prompt for image-only raw requests', async () => {
		analyzeImagesMock.mockResolvedValue({
			text: 'Image describes a beam task.',
			model: 'vision-model',
			tokens: 21
		});
		routeTaskMock.mockResolvedValue({
			kind: 'general_answer',
			requiresCodeGen: false,
			confidence: 0.8,
			source: 'model',
			model: 'router-test',
			tokens: 12
		});
		answerNonComputationalTaskMock.mockResolvedValue({
			text: 'answer',
			model: 'text-test',
			tokens: 7
		});

		await runPipeline(
			'',
			[],
			async () => {},
			[
				{ base64: 'FIRST', mimeType: 'image/png' },
				{ base64: 'SECOND', mimeType: 'image/jpeg' }
			]
		);

		expect(analyzeImagesMock).toHaveBeenCalledWith(
			[],
			[
				{ base64: 'FIRST', mimeType: 'image/png' },
				{ base64: 'SECOND', mimeType: 'image/jpeg' }
			],
			undefined
		);
		expect(routeTaskMock.mock.calls[0][1]).toContain('прикреплённым изображениям');
		expect(routeTaskMock.mock.calls[0][1]).toContain('Image describes a beam task.');
		expect(answerNonComputationalTaskMock).toHaveBeenCalledTimes(1);
	});

	it('uses finalizer-only mode for approved explain follow-up', async () => {
		routeApprovedFollowupMock.mockResolvedValue({
			intent: 'explain_followup',
			model: 'router-followup',
			tokens: 11
		});
		assembleFinalAnswerMock.mockResolvedValue({
			text: 'follow-up explanation',
			model: 'finalizer-model',
			tokens: 19
		});

		const events: Array<Record<string, unknown>> = [];
		await runPipeline(
			'Почему знак момента такой?',
			[],
			async (event) => {
				events.push(event as unknown as Record<string, unknown>);
			},
			undefined,
			null,
			{
				approvedFollowupContext: {
					draftId: 'draft-1',
					originalTask: 'Original task',
					approvedSchema: {} as any,
					approvedSchemeDescription: 'Approved description',
					recentChatContext: [{ role: 'USER', content: 'Ранее: реши задачу' }],
					previousSolved: {
						answerText: 'Solved answer',
						exactAnswers: [
							{
								id: 'R_A',
								label: 'Reaction A',
								valueText: '10',
								numericValue: 10
							}
						],
						graphData: []
					}
				}
			}
		);

		expect(routeApprovedFollowupMock).toHaveBeenCalledTimes(1);
		expect(generatePythonCodeMock).not.toHaveBeenCalled();
		expect(assembleFinalAnswerMock).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.type === 'result' && event.draftId === 'draft-1')).toBe(true);
	});

	it('routes independent approved follow-up through generic router', async () => {
		routeApprovedFollowupMock.mockResolvedValue({
			intent: 'independent_message',
			model: 'router-followup',
			tokens: 8
		});
		routeTaskMock.mockResolvedValue({
			kind: 'general_answer',
			requiresCodeGen: false,
			confidence: 0.8,
			source: 'model',
			model: 'router-test',
			tokens: 7
		});
		answerNonComputationalTaskMock.mockResolvedValue({
			text: 'general answer',
			model: 'text-model',
			tokens: 5
		});

		await runPipeline(
			'Новая отдельная задача',
			[],
			async () => {},
			undefined,
			null,
			{
				approvedFollowupContext: {
					draftId: 'draft-1',
					originalTask: 'Original task',
					approvedSchema: {} as any
				}
			}
		);

		expect(routeApprovedFollowupMock).toHaveBeenCalledTimes(1);
		expect(routeTaskMock).toHaveBeenCalledTimes(1);
		expect(answerNonComputationalTaskMock).toHaveBeenCalledTimes(1);
		expect(generateResultSchemaPatchMock).not.toHaveBeenCalled();
	});

	it('uses non-CodeGen path for explicit no-solve schema description requests', async () => {
		routeTaskByRulesMock.mockReturnValue({
			kind: 'schema_description',
			requiresCodeGen: false,
			confidence: 0.98,
			source: 'rules'
		});
		answerNonComputationalTaskMock.mockResolvedValue({
			text: 'Описание схемы',
			model: 'text-model',
			tokens: 9
		});

		const events: Array<Record<string, unknown>> = [];
		await runPipeline('Не решай, только опиши схему', [], async (event) => {
			events.push(event as unknown as Record<string, unknown>);
		});

		const result = events.find((event) => event.type === 'result');
		expect(routeTaskMock).not.toHaveBeenCalled();
		expect(answerNonComputationalTaskMock).toHaveBeenCalledWith(
			[],
			expect.objectContaining({ taskKind: 'schema_description' }),
			undefined
		);
		expect(generatePythonCodeMock).not.toHaveBeenCalled();
		expect(result?.exactAnswers).toBeUndefined();
		expect(result?.generatedCode).toBeUndefined();
	});

	it('uses non-CodeGen path for document report requests even when document text looks mathematical', async () => {
		routeTaskByRulesMock.mockReturnValue({
			kind: 'document_transform',
			requiresCodeGen: false,
			confidence: 0.95,
			source: 'rules'
		});
		answerNonComputationalTaskMock.mockResolvedValue({
			text: 'Отчет по лабораторной работе',
			model: 'text-model',
			tokens: 14
		});

		await runPipeline(
			'Заполни отчет по лабораторной работе из PDF\n\n[ATTACHED_DOCUMENTS]\nФайл: lab.pdf\nТекст документа:\nНайти реакции опор балки.',
			[],
			async () => {}
		);

		expect(answerNonComputationalTaskMock).toHaveBeenCalledTimes(1);
		expect(generatePythonCodeMock).not.toHaveBeenCalled();
		expect(assembleFinalAnswerMock).not.toHaveBeenCalled();
	});

	it('uses non-CodeGen path for approved report follow-up without carrying exact answers into result fields', async () => {
		routeApprovedFollowupMock.mockResolvedValue({
			intent: 'noncomputational_followup',
			model: 'router-followup',
			tokens: 8
		});
		answerNonComputationalTaskMock.mockResolvedValue({
			text: 'Краткий отчет',
			model: 'text-model',
			tokens: 11
		});

		const events: Array<Record<string, unknown>> = [];
		await runPipeline(
			'Оформи это как отчет без решения',
			[],
			async (event) => {
				events.push(event as unknown as Record<string, unknown>);
			},
			undefined,
			null,
			{
				approvedFollowupContext: {
					draftId: 'draft-1',
					originalTask: 'Original task',
					approvedSchema: makeApprovedSchema(),
					previousSolved: {
						answerText: 'Solved answer',
						exactAnswers: [
							{
								id: 'R_A',
								label: 'Reaction A',
								valueText: '10',
								numericValue: 10
							}
						],
						graphData: []
					}
				}
			}
		);

		const result = events.find((event) => event.type === 'result');
		expect(generatePythonCodeMock).not.toHaveBeenCalled();
		expect(assembleFinalAnswerMock).not.toHaveBeenCalled();
		expect(result?.draftId).toBe('draft-1');
		expect(result?.exactAnswers).toBeUndefined();
		expect(result?.generatedCode).toBeUndefined();
	});

	it('decorates approved-schema solve with an optional result scheme overlay', async () => {
		generatePythonCodeMock.mockResolvedValue({
			code: 'print("ok")',
			model: 'code-model',
			tokens: 13
		});
		assembleFinalAnswerMock.mockResolvedValue({
			text: 'solution text',
			model: 'finalizer-model',
			tokens: 17
		});
		generateResultSchemaPatchMock.mockResolvedValue({
			output: {
				schemaPatch: {
					deleteObjectIds: [],
					deleteResultIds: [],
					addNodes: [],
					addObjects: [
						{
							id: 'result_v_B',
							type: 'velocity',
							nodeRefs: ['B'],
							geometry: { direction: { x: 1, y: 0 }, magnitude: 2 },
							label: 'v_B'
						}
					],
					addResults: []
				}
			},
			model: 'overlay-model',
			tokens: 5
		});

		const events: Array<Record<string, unknown>> = [];
		await runPipelineWithApprovedSchema(
			{
				userMessage: 'Find velocity at B',
				approvedSchema: makeApprovedSchema(),
				approvedSchemeDescription: 'Approved beam'
			},
			[],
			async (event) => {
				events.push(event as unknown as Record<string, unknown>);
			},
			undefined,
			null,
			{
				sandboxExecutor: async () => ({ stdout: makeSolveStdout() })
			}
		);

		expect(assembleFinalAnswerMock).toHaveBeenCalledTimes(1);
		expect(generateResultSchemaPatchMock).toHaveBeenCalledTimes(1);
		expect(assembleFinalAnswerMock.mock.invocationCallOrder[0]).toBeLessThan(
			generateResultSchemaPatchMock.mock.invocationCallOrder[0]
		);
		const result = events.find((event) => event.type === 'result');
		const schemaData = result?.schemaData as { objects?: Array<{ id: string; type: string }> };
		expect(schemaData.objects?.some((object) => object.id === 'result_v_B' && object.type === 'velocity')).toBe(
			true
		);
		expect((result?.graphData as unknown[]).length).toBe(1);
		expect((result?.exactAnswers as unknown[]).length).toBe(1);
		expect(result?.schemaDescription).toBe('Approved beam');
		expect((result?.usedModels as string[]).some((entry) => entry.includes('SchemeOverlay'))).toBe(true);
	});

	it('falls back to approved schema when result scheme overlay is invalid', async () => {
		generatePythonCodeMock.mockResolvedValue({
			code: 'print("ok")',
			model: 'code-model',
			tokens: 13
		});
		assembleFinalAnswerMock.mockResolvedValue({
			text: 'solution text',
			model: 'finalizer-model',
			tokens: 17
		});
		generateResultSchemaPatchMock.mockResolvedValue({
			output: {
				schemaPatch: {
					deleteObjectIds: [],
					deleteResultIds: [],
					addNodes: [],
					addObjects: [
						{
							id: 'result_bar',
							type: 'bar',
							nodeRefs: ['A', 'B'],
							geometry: { length: 4, angleDeg: 0 }
						}
					],
					addResults: []
				}
			},
			model: 'overlay-model',
			tokens: 5
		});

		const events: Array<Record<string, unknown>> = [];
		await runPipelineWithApprovedSchema(
			{
				userMessage: 'Find velocity at B',
				approvedSchema: makeApprovedSchema()
			},
			[],
			async (event) => {
				events.push(event as unknown as Record<string, unknown>);
			},
			undefined,
			null,
			{
				sandboxExecutor: async () => ({ stdout: makeSolveStdout() })
			}
		);

		const result = events.find((event) => event.type === 'result');
		const schemaData = result?.schemaData as { objects?: Array<{ id: string; type: string }> };
		expect(schemaData.objects).toHaveLength(1);
		expect(schemaData.objects?.[0]).toMatchObject({ id: 'bar_1', type: 'bar' });
		expect((result?.graphData as unknown[]).length).toBe(1);
		expect((result?.exactAnswers as unknown[]).length).toBe(1);
	});

	it('falls back to approved schema when result scheme overlay is empty', async () => {
		generatePythonCodeMock.mockResolvedValue({
			code: 'print("ok")',
			model: 'code-model',
			tokens: 13
		});
		assembleFinalAnswerMock.mockResolvedValue({
			text: 'solution text',
			model: 'finalizer-model',
			tokens: 17
		});
		generateResultSchemaPatchMock.mockResolvedValue({
			output: {
				schemaPatch: {
					deleteObjectIds: [],
					deleteResultIds: [],
					addNodes: [],
					addObjects: [],
					addResults: []
				}
			},
			model: 'overlay-model',
			tokens: 5
		});

		const events: Array<Record<string, unknown>> = [];
		await runPipelineWithApprovedSchema(
			{
				userMessage: 'Find velocity at B',
				approvedSchema: makeApprovedSchema()
			},
			[],
			async (event) => {
				events.push(event as unknown as Record<string, unknown>);
			},
			undefined,
			null,
			{
				sandboxExecutor: async () => ({ stdout: makeSolveStdout() })
			}
		);

		const result = events.find((event) => event.type === 'result');
		const schemaData = result?.schemaData as { objects?: Array<{ id: string; type: string }> };
		expect(schemaData.objects).toHaveLength(1);
		expect(schemaData.objects?.[0]).toMatchObject({ id: 'bar_1', type: 'bar' });
	});

	it('does not request result scheme overlays for raw-prompt solves', async () => {
		routeTaskMock.mockResolvedValue({
			kind: 'solve_computation',
			requiresCodeGen: true,
			confidence: 0.95,
			source: 'model',
			model: 'router-model',
			tokens: 3
		});
		generatePythonCodeMock.mockResolvedValue({
			code: 'print("ok")',
			model: 'code-model',
			tokens: 13
		});
		assembleFinalAnswerMock.mockResolvedValue({
			text: 'solution text',
			model: 'finalizer-model',
			tokens: 17
		});

		await runPipeline(
			'Find velocity at B',
			[],
			async () => {},
			undefined,
			null,
			{
				sandboxExecutor: async () => ({ stdout: makeSolveStdout() })
			}
		);

		expect(generateResultSchemaPatchMock).not.toHaveBeenCalled();
	});
});
