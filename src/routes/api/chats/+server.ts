/**
 * +server.ts - Chat management
 * POST /api/chats -> create new chat
 * GET /api/chats -> list user's chats
 */
import type { RequestHandler } from './$types';
import { prisma } from '$lib/server/db.js';
import {
	DEFAULT_MODEL_PREFERENCE,
	isModelPreference,
	normalizeModelPreference,
	type ModelPreference
} from '$lib/server/ai/model-preference.js';
import { getChatProcessingForUser } from '$lib/server/chat-processing.js';
import { json, error } from '@sveltejs/kit';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return error(401, 'Нужно войти в аккаунт.');

	let title = '\u041d\u043e\u0432\u044b\u0439 \u0447\u0430\u0442';
	let modelPreference: ModelPreference = DEFAULT_MODEL_PREFERENCE;
	let body: { title?: string; modelPreference?: string } = {};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		// title/modelPreference remain defaults for empty body
	}
	if (body.title) title = body.title;
	if (body.modelPreference !== undefined) {
		if (!isModelPreference(body.modelPreference)) {
			return error(400, `Неподдерживаемая модель: ${String(body.modelPreference)}`);
		}
		modelPreference = normalizeModelPreference(body.modelPreference);
	}

	const chat = await prisma.chat.create({
		data: { userId: locals.user.id, title, modelPreference }
	});
	console.log('[ModelPreference:API] chat created', {
		chatId: chat.id,
		userId: locals.user.id,
		modelPreference: normalizeModelPreference(chat.modelPreference)
	});

	return json({ ...chat, modelPreference: normalizeModelPreference(chat.modelPreference) }, { status: 201 });
};

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return error(401, 'Нужно войти в аккаунт.');
	const activeProcessing = getChatProcessingForUser(locals.user.id);

	const chats = await prisma.chat.findMany({
		where: { userId: locals.user.id },
		orderBy: [
			{ isPinned: 'desc' },
			{ updatedAt: 'desc' }
		],
		select: {
			id: true,
			title: true,
			updatedAt: true,
			isPinned: true,
			modelPreference: true,
			isPublic: true
		}
	});

	return json(
		chats.map((chat) => ({
			...chat,
			modelPreference: normalizeModelPreference(chat.modelPreference),
			isProcessing: activeProcessing?.chatId === chat.id,
			processingKind: activeProcessing?.chatId === chat.id ? activeProcessing.kind : null,
			processingStatus: activeProcessing?.chatId === chat.id ? activeProcessing.statusMessage : null
		}))
	);
};
