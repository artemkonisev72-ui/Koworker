import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	const db = prisma as any;

	const draft = await db.taskDraft.findUnique({
		where: { id: params.draftId },
		include: {
			revisions: {
				orderBy: { revisionIndex: 'desc' },
				take: 1
			}
		}
	});

	if (!draft) return error(404, 'Draft not found');
	if (draft.userId !== locals.user.id) return error(403, 'Forbidden');

	const latestRevision = draft.revisions?.[0] ?? null;

	return json({
		draftId: draft.id,
		chatId: draft.chatId,
		mode: draft.mode,
		status: draft.status,
		revisionCount: draft.revisionCount,
		currentSchema: draft.currentSchema,
		approvedSchema: draft.approvedSchema,
		latestRevision: latestRevision
			? {
				revisionIndex: latestRevision.revisionIndex,
				userNotes: latestRevision.userNotes,
				schema: latestRevision.schema,
				assumptions: latestRevision.assumptions,
				createdAt: latestRevision.createdAt
			}
			: null,
		createdAt: draft.createdAt,
		updatedAt: draft.updatedAt
	});
};
