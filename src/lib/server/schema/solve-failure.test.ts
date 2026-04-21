import { describe, expect, it, vi } from 'vitest';
import { persistSchemaSolveFailure } from './solve-failure.js';

describe('persistSchemaSolveFailure', () => {
	it('keeps draft as FAILED and stores diagnostic solutionDoc in detailed mode', async () => {
		const update = vi.fn().mockResolvedValue({});
		const create = vi.fn().mockResolvedValue({});
		const db = {
			taskDraft: { update },
			message: { create }
		};

		await persistSchemaSolveFailure({
			db,
			draftId: 'draft-1',
			chatId: 'chat-1',
			schemaVersion: '2.0',
			userMessage: 'Реши задачу',
			errorMessage: 'fetch failed',
			detailedSolution: true
		});

		expect(update).toHaveBeenCalledWith({
			where: { id: 'draft-1' },
			data: { status: 'FAILED' }
		});
		expect(create).toHaveBeenCalledTimes(1);
		const payload = create.mock.calls[0][0] as { data: Record<string, unknown> };
		expect(payload.data.content).toBeTypeOf('string');
		expect(payload.data.solutionDoc).toBeTruthy();
	});

	it('stores plain error message without solutionDoc in non-detailed mode', async () => {
		const update = vi.fn().mockResolvedValue({});
		const create = vi.fn().mockResolvedValue({});
		const db = {
			taskDraft: { update },
			message: { create }
		};

		await persistSchemaSolveFailure({
			db,
			draftId: 'draft-2',
			chatId: 'chat-2',
			schemaVersion: '2.0',
			userMessage: 'Solve',
			errorMessage: 'timeout',
			detailedSolution: false
		});

		const payload = create.mock.calls[0][0] as { data: Record<string, unknown> };
		expect(payload.data.solutionDoc).toBeUndefined();
		expect(String(payload.data.content)).toContain('Schema-confirmed solve failed');
	});
});
