import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	runPipelineMock,
	chatFindUniqueMock,
	chatUpdateMock,
	messageFindManyMock,
	messageCreateMock,
	messageCountMock,
	acquireChatProcessingMock,
	updateStatusMock,
	releaseMock
} = vi.hoisted(() => ({
	runPipelineMock: vi.fn(),
	chatFindUniqueMock: vi.fn(),
	chatUpdateMock: vi.fn(),
	messageFindManyMock: vi.fn(),
	messageCreateMock: vi.fn(),
	messageCountMock: vi.fn(),
	acquireChatProcessingMock: vi.fn(),
	updateStatusMock: vi.fn(),
	releaseMock: vi.fn()
}));

vi.mock('$lib/server/ai/pipeline.js', () => ({
	runPipeline: runPipelineMock
}));

vi.mock('$lib/server/ai/model-preference.js', () => ({
	isModelPreference: () => true,
	normalizeModelPreference: (value: unknown) => (typeof value === 'string' ? value : 'auto'),
	toForcedModel: () => null
}));

vi.mock('$lib/server/chat-processing.js', () => ({
	acquireChatProcessing: acquireChatProcessingMock,
	ChatProcessingConflictError: class ChatProcessingConflictError extends Error {}
}));

vi.mock('$lib/server/db.js', () => ({
	prisma: {
		chat: {
			findUnique: chatFindUniqueMock,
			update: chatUpdateMock
		},
		message: {
			findMany: messageFindManyMock,
			create: messageCreateMock,
			count: messageCountMock
		}
	}
}));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { POST } from '../../routes/api/chat/+server.ts';

describe('POST /api/chat detailed error handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatFindUniqueMock.mockResolvedValue({
			id: 'chat-1',
			userId: 'user-1',
			modelPreference: 'auto'
		});
		messageFindManyMock.mockResolvedValue([]);
		messageCountMock.mockResolvedValue(2);
		chatUpdateMock.mockResolvedValue({});
		messageCreateMock
			.mockResolvedValueOnce({ id: 'user-message-1' })
			.mockResolvedValueOnce({ id: 'assistant-message-1' });
		acquireChatProcessingMock.mockReturnValue({
			updateStatus: updateStatusMock,
			release: releaseMock
		});
		runPipelineMock.mockImplementation(
			async (_message: string, _history: unknown[], onStatus: (event: unknown) => Promise<void>) => {
				await onStatus({
					type: 'error',
					message: 'Внутренняя ошибка: fetch failed'
				});
			}
		);
	});

	it('persists diagnostic solutionDoc and streams result event in detailed mode', async () => {
		const request = new Request('http://localhost/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chatId: 'chat-1',
				message: 'Реши задачу',
				detailedSolution: true
			})
		});

		const response = await POST({
			locals: { user: { id: 'user-1' } },
			request,
			url: new URL('http://localhost/api/chat')
		} as any);

		expect(response.status).toBe(200);
		const payload = await response.text();
		const dataLines = payload
			.split('\n')
			.filter((line) => line.startsWith('data: '))
			.map((line) => line.slice(6).trim())
			.filter((line) => line !== '[DONE]');

		const events = dataLines.map((line) => JSON.parse(line) as Record<string, unknown>);
		const resultEvent = events.find((event) => event.type === 'result');
		expect(resultEvent).toBeTruthy();
		expect(resultEvent?.messageId).toBe('assistant-message-1');
		expect(resultEvent?.solutionDoc).toBeTruthy();

		expect(messageCreateMock).toHaveBeenCalledTimes(2);
		const assistantCreateCall = messageCreateMock.mock.calls[1][0] as {
			data: Record<string, unknown>;
		};
		expect(assistantCreateCall.data.solutionDoc).toBeTruthy();
		expect(assistantCreateCall.data.content).toBeTypeOf('string');
	});
});
