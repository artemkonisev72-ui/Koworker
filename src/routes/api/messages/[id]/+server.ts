import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { prisma } from '$lib/server/db';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return error(401, 'Нужно войти в аккаунт.');

	const { id } = params;

	const message = await prisma.message.findUnique({
		where: { id },
		include: { chat: true }
	});

	if (!message) return error(404, 'Message not found');
	if (message.chat.userId !== locals.user.id) return error(403, 'Нет доступа к этому сообщению.');

	await prisma.message.delete({ where: { id } });

	return json({ success: true });
};
