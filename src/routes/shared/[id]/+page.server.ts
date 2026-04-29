import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { prisma } from '$lib/server/db';
import { parseStoredChatImages } from '$lib/chat/images.js';

function parseMaybeJson(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

export const load: PageServerLoad = async ({ params }) => {
	const db = prisma as any;
	const { id } = params;

	const chat = await db.chat.findUnique({
		where: { id },
		include: {
			messages: {
				orderBy: { createdAt: 'asc' }
			}
		}
	});

	if (!chat) {
		throw error(404, 'Chat not found');
	}

	if (!chat.isPublic) {
		throw error(403, 'This chat is not public');
	}

	return {
		chat: {
			id: chat.id,
			title: chat.title,
			createdAt: chat.createdAt
		},
		messages: chat.messages.map((m: any) => ({
			id: m.id,
			role: m.role,
			content: m.content,
			imageData: parseStoredChatImages(m.imageData),
			generatedCode: m.generatedCode,
			executionLogs: m.executionLogs,
			graphData: parseMaybeJson(m.graphData),
			exactAnswers: parseMaybeJson(m.exactAnswers),
			schemaData: parseMaybeJson(m.schemaData),
			schemaDescription: typeof m.schemaDescription === 'string' ? m.schemaDescription : null,
			schemaVersion: m.schemaVersion,
			usedModels: parseMaybeJson(m.usedModels),
			draftId: m.draftId,
			createdAt: m.createdAt.toISOString()
		}))
	};
};
