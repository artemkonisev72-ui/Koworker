import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	routeQuestionMock,
	routeApprovedFollowupMock,
	answerGeneralQuestionMock,
	analyzeImageMock,
	generatePythonCodeMock,
	assembleFinalAnswerMock
} = vi.hoisted(() => ({
	routeQuestionMock: vi.fn(),
	routeApprovedFollowupMock: vi.fn(),
	answerGeneralQuestionMock: vi.fn(),
	analyzeImageMock: vi.fn(),
	generatePythonCodeMock: vi.fn(),
	assembleFinalAnswerMock: vi.fn()
}));

vi.mock('./gemini.ts', () => ({
	routeQuestion: routeQuestionMock,
	routeApprovedFollowup: routeApprovedFollowupMock,
	answerGeneralQuestion: answerGeneralQuestionMock,
	analyzeImage: analyzeImageMock,
	generatePythonCode: generatePythonCodeMock,
	assembleFinalAnswer: assembleFinalAnswerMock
}));

vi.mock('../sandbox/worker-pool.js', () => ({
	workerPool: {
		execute: vi.fn()
	},
	SandboxError: class SandboxError extends Error {}
}));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { runPipeline } from './pipeline.ts';

describe('runPipeline status sink', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('awaits async status callbacks before continuing pipeline steps', async () => {
		let stage = 'initial';

		routeQuestionMock.mockImplementation(async () => {
			expect(stage).toBe('route-status-finished');
			return {
				result: false,
				model: 'router-test',
				tokens: 12
			};
		});

		answerGeneralQuestionMock.mockImplementation(async () => {
			expect(stage).toBe('final-status-finished');
			return {
				text: 'ok',
				model: 'text-test',
				tokens: 7
			};
		});

		await runPipeline('test message', [], async (event) => {
			if (event.type === 'status' && event.message === 'Анализ задачи...') {
				await Promise.resolve();
				stage = 'route-status-finished';
			}
			if (event.type === 'status' && event.message === 'Формирование ответа...') {
				await Promise.resolve();
				stage = 'final-status-finished';
			}
		});

		expect(routeQuestionMock).toHaveBeenCalledTimes(1);
		expect(answerGeneralQuestionMock).toHaveBeenCalledTimes(1);
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
		routeQuestionMock.mockResolvedValue({
			result: false,
			model: 'router-test',
			tokens: 7
		});
		answerGeneralQuestionMock.mockResolvedValue({
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
		expect(routeQuestionMock).toHaveBeenCalledTimes(1);
		expect(answerGeneralQuestionMock).toHaveBeenCalledTimes(1);
	});
});
