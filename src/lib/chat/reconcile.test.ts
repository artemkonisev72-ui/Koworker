import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import {
	canDeleteMessage,
	dedupeMessagesById,
	isTempMessageId,
	reconcileMessageId
} from './reconcile.ts';

describe('chat message reconciliation helpers', () => {
	it('marks temp ids and blocks delete for optimistic/streaming messages', () => {
		expect(isTempMessageId('temp-123')).toBe(true);
		expect(isTempMessageId('cm123')).toBe(false);
		expect(canDeleteMessage({ id: 'temp-1' })).toBe(false);
		expect(canDeleteMessage({ id: 'cm1', isOptimistic: true })).toBe(false);
		expect(canDeleteMessage({ id: 'cm1', isStreaming: true })).toBe(false);
		expect(canDeleteMessage({ id: 'cm1' })).toBe(true);
	});

	it('reconciles temp id to persisted id and clears optimistic flag', () => {
		const initial = [
			{ id: 'temp-user', role: 'USER', isOptimistic: true },
			{ id: 'temp-assistant', role: 'ASSISTANT', isOptimistic: true }
		];
		const reconciled = reconcileMessageId(initial, 'temp-user', 'cm_user_1');
		expect(reconciled.map((message) => message.id)).toEqual(['cm_user_1', 'temp-assistant']);
		expect(reconciled[0]?.isOptimistic).toBe(false);
	});

	it('dedupes out-of-order messages after reconciliation', () => {
		const initial = [
			{ id: 'cm_user_1', role: 'USER', isOptimistic: false, content: 'persisted' },
			{ id: 'temp-user', role: 'USER', isOptimistic: true, content: 'optimistic' }
		];
		const reconciled = reconcileMessageId(initial, 'temp-user', 'cm_user_1');
		expect(reconciled).toHaveLength(1);
		expect(reconciled[0]?.id).toBe('cm_user_1');
		expect(reconciled[0]?.isOptimistic).toBe(false);
		expect(reconciled[0]?.content).toBe('optimistic');
		expect(dedupeMessagesById(initial)).toHaveLength(2);
	});
});
