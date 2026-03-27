/**
 * +server.ts — Chat management
 * POST /api/chats  → create new chat
 * GET  /api/chats  → list user's chats
 *
 * NOTE: Auth is stubbed — in production replace with real session.
 * For now we use a demo user (created on first request).
 */
import type { RequestHandler } from './$types';
import { prisma } from '$lib/server/db.js';
import { json, error } from '@sveltejs/kit';

const DEMO_EMAIL = 'demo@coworker.ai';

async function getOrCreateDemoUser() {
	return prisma.user.upsert({
		where: { email: DEMO_EMAIL },
		update: {},
		create: { email: DEMO_EMAIL }
	});
}

export const POST: RequestHandler = async ({ request }) => {
	const user = await getOrCreateDemoUser();
	let title = 'Новый чат';

	try {
		const body = (await request.json()) as { title?: string };
		if (body.title) title = body.title;
	} catch {
		// title remains default
	}

	const chat = await prisma.chat.create({
		data: { userId: user.id, title }
	});

	return json(chat, { status: 201 });
};

export const GET: RequestHandler = async () => {
	const user = await getOrCreateDemoUser();

	const chats = await prisma.chat.findMany({
		where: { userId: user.id },
		orderBy: { updatedAt: 'desc' },
		select: { id: true, title: true, updatedAt: true }
	});

	return json(chats);
};
