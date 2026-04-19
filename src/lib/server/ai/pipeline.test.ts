import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	routeQuestionMock,
	answerGeneralQuestionMock,
	analyzeImageMock,
	generatePythonCodeMock,
	assembleFinalAnswerMock
} = vi.hoisted(() => ({
	routeQuestionMock: vi.fn(),
	answerGeneralQuestionMock: vi.fn(),
	analyzeImageMock: vi.fn(),
	generatePythonCodeMock: vi.fn(),
	assembleFinalAnswerMock: vi.fn()
}));

vi.mock('./gemini.ts', () => ({
	routeQuestion: routeQuestionMock,
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
});
