/**
 * +server.ts — Chat management
 * POST /api/chats  → create new chat
 * GET  /api/chats  → list user's chats
 */
import type { RequestHandler } from './$types';
import { prisma } from '$lib/server/db.js';
import { json, error } from '@sveltejs/kit';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return error(401, 'Unauthorized');

	let title = 'Новый чат';
	try {
		const body = (await request.json()) as { title?: string };
		if (body.title) title = body.title;
	} catch {
		// title remains default
	}

	const chat = await prisma.chat.create({
		data: { userId: locals.user.id, title }
	});

	return json(chat, { status: 201 });
};

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return error(401, 'Unauthorized');

	const chats = await prisma.chat.findMany({
		where: { userId: locals.user.id },
		orderBy: [
			{ isPinned: 'desc' },
			{ updatedAt: 'desc' }
		],
		select: { id: true, title: true, updatedAt: true, isPinned: true }
	});

	return json(chats);
};
