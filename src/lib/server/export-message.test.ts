import { describe, expect, it, vi } from 'vitest';
import { loadExportMessageForViewer } from './export-message.js';

function makeMessage(overrides: Record<string, unknown> = {}) {
	return {
		id: 'msg-1',
		role: 'ASSISTANT',
		content: 'Solved',
		graphData: '[{"title":"Graph","points":[{"x":0,"y":0},{"x":1,"y":1}]}]',
		exactAnswers: '[{"label":"N","valueText":"10"}]',
		schemaData: null,
		schemaDescription: null,
		schemaVersion: '2.0',
		usedModels: '["gemini-3.1-pro-preview"]',
		createdAt: new Date('2026-04-20T10:20:30.000Z'),
		chat: {
			id: 'chat-1',
			title: 'Test chat',
			isPublic: false,
			userId: 'owner-1'
		},
		...overrides
	};
}

function makeDb(message: Record<string, unknown> | null) {
	return {
		message: {
			findUnique: vi.fn().mockResolvedValue(message)
		}
	};
}

describe('loadExportMessageForViewer', () => {
	it('allows owner to export a private chat message', async () => {
		const db = makeDb(makeMessage());

		const payload = await loadExportMessageForViewer({
			messageId: 'msg-1',
			viewerUserId: 'owner-1',
			db
		});

		expect(payload.chat.id).toBe('chat-1');
		expect(payload.message.id).toBe('msg-1');
		expect(Array.isArray(payload.message.graphData)).toBe(true);
		expect(payload.message.createdAt).toBe('2026-04-20T10:20:30.000Z');
	});

	it('rejects anonymous access to a private chat message', async () => {
		const db = makeDb(makeMessage());

		await expect(
			loadExportMessageForViewer({
				messageId: 'msg-1',
				viewerUserId: null,
				db
			})
		).rejects.toMatchObject({ status: 401 });
	});

	it('rejects non-owner access to a private chat message', async () => {
		const db = makeDb(makeMessage());

		await expect(
			loadExportMessageForViewer({
				messageId: 'msg-1',
				viewerUserId: 'another-user',
				db
			})
		).rejects.toMatchObject({ status: 403 });
	});

	it('allows anonymous access to a public chat message', async () => {
		const db = makeDb(
			makeMessage({
				chat: {
					id: 'chat-public',
					title: 'Public chat',
					isPublic: true,
					userId: 'owner-1'
				}
			})
		);

		const payload = await loadExportMessageForViewer({
			messageId: 'msg-1',
			viewerUserId: null,
			db
		});

		expect(payload.chat.isPublic).toBe(true);
		expect(payload.message.usedModels).toEqual(['gemini-3.1-pro-preview']);
	});
});
