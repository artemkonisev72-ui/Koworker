import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { prisma } from '$lib/server/db';

export const load: PageServerLoad = async ({ params }) => {
	const { id } = params;

	const chat = await prisma.chat.findUnique({
		where: { id },
		include: {
			messages: {
				orderBy: { createdAt: 'asc' }
			}
		}
	});

	if (!chat) {
		throw error(404, 'Чат не найден');
	}

	if (!chat.isPublic) {
		throw error(403, 'Этот чат не является публичным');
	}

	return {
		chat: {
			id: chat.id,
			title: chat.title,
			createdAt: chat.createdAt
		},
		messages: chat.messages.map(m => ({
			id: m.id,
			role: m.role,
			content: m.content,
			imageData: m.imageData ? JSON.parse(m.imageData as string) : null,
			generatedCode: m.generatedCode as string | null,
			executionLogs: m.executionLogs as string | null,
			graphData: m.graphData ? JSON.parse(m.graphData as string) : null,
			usedModels: m.usedModels ? JSON.parse(m.usedModels as string) : null,
			createdAt: m.createdAt.toISOString()
		}))
	};
};
