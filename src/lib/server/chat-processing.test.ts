import { afterEach, describe, expect, it } from 'vitest';
import {
	acquireChatProcessing,
	ChatProcessingConflictError,
	getChatProcessingForUser,
	resetChatProcessingStoreForTests
} from './chat-processing.js';

describe('chat-processing registry', () => {
	afterEach(() => {
		resetChatProcessingStoreForTests();
	});

	it('tracks the active chat processing for a user', () => {
		const handle = acquireChatProcessing({
			userId: 'user-1',
			chatId: 'chat-1',
			kind: 'chat',
			statusMessage: 'Preparing response...'
		});

		expect(getChatProcessingForUser('user-1')).toEqual({
			chatId: 'chat-1',
			kind: 'chat',
			statusMessage: 'Preparing response...',
			startedAt: handle.startedAt
		});

		handle.updateStatus('Saving answer...');

		expect(getChatProcessingForUser('user-1')).toEqual({
			chatId: 'chat-1',
			kind: 'chat',
			statusMessage: 'Saving answer...',
			startedAt: handle.startedAt
		});
	});

	it('rejects concurrent processing for the same user until the lock is released', () => {
		const handle = acquireChatProcessing({
			userId: 'user-1',
			chatId: 'chat-1',
			kind: 'schema_start',
			statusMessage: 'Строю первичную схему...'
		});

		expect(() =>
			acquireChatProcessing({
				userId: 'user-1',
				chatId: 'chat-2',
				kind: 'chat',
				statusMessage: 'Preparing response...'
			})
		).toThrowError(ChatProcessingConflictError);

		handle.release();

		const nextHandle = acquireChatProcessing({
			userId: 'user-1',
			chatId: 'chat-2',
			kind: 'chat',
			statusMessage: 'Preparing response...'
		});

		expect(getChatProcessingForUser('user-1')).toEqual({
			chatId: 'chat-2',
			kind: 'chat',
			statusMessage: 'Preparing response...',
			startedAt: nextHandle.startedAt
		});
	});

	it('allows different users to process different chats in parallel', () => {
		const handleA = acquireChatProcessing({
			userId: 'user-a',
			chatId: 'chat-a',
			kind: 'chat',
			statusMessage: 'Preparing response...'
		});
		const handleB = acquireChatProcessing({
			userId: 'user-b',
			chatId: 'chat-b',
			kind: 'schema_confirm',
			statusMessage: 'Solve started. Waiting for result...'
		});

		expect(getChatProcessingForUser('user-a')).toEqual({
			chatId: 'chat-a',
			kind: 'chat',
			statusMessage: 'Preparing response...',
			startedAt: handleA.startedAt
		});
		expect(getChatProcessingForUser('user-b')).toEqual({
			chatId: 'chat-b',
			kind: 'schema_confirm',
			statusMessage: 'Solve started. Waiting for result...',
			startedAt: handleB.startedAt
		});
	});
});
