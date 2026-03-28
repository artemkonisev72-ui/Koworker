import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { prisma } from '$lib/server/db';

// PATCH /api/chats/[id] — rename or pin chat
export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) return error(401, 'Unauthorized');

	const { id } = params;
	const body = await request.json() as { title?: string; isPinned?: boolean; modelPreference?: string };

	const chat = await prisma.chat.findUnique({ where: { id: id } });

	if (!chat) return error(404, 'Chat not found');
	if (chat.userId !== locals.user.id) return error(403, 'Forbidden');

	const updated = await prisma.chat.update({
		where: { id },
		data: {
			title: body.title !== undefined ? body.title : undefined,
			isPinned: body.isPinned !== undefined ? body.isPinned : undefined,
			modelPreference: body.modelPreference !== undefined ? body.modelPreference : undefined
		}
	});

	return json(updated);
};

// DELETE /api/chats/[id] — delete chat
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return error(401, 'Unauthorized');

	const { id } = params;

	const chat = await prisma.chat.findUnique({ where: { id } });

	if (!chat) return error(404, 'Chat not found');
	if (chat.userId !== locals.user.id) return error(403, 'Forbidden');

	await prisma.chat.delete({ where: { id } });

	return json({ success: true });
};
