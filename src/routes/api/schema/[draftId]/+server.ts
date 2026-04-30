import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { logSchemaCheck } from '$lib/server/schema/flow.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return error(401, 'Нужно войти в аккаунт.');
	const db = prisma as any;
	logSchemaCheck('get.request', { userId: locals.user.id, draftId: params.draftId });

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
	if (draft.userId !== locals.user.id) return error(403, 'Нет доступа к этому черновику.');
	logSchemaCheck('get.loaded', {
		draftId: draft.id,
		chatId: draft.chatId,
		status: draft.status,
		revisionCount: draft.revisionCount
	});

	const latestRevision = draft.revisions?.[0] ?? null;

	return json({
		draftId: draft.id,
		chatId: draft.chatId,
		mode: draft.mode,
		status: draft.status,
		schemaVersion: draft.schemaVersion ?? '1.0',
		revisionCount: draft.revisionCount,
		currentUnderstanding: draft.currentUnderstanding,
		currentIntent: draft.currentIntent,
		approvedUnderstanding: draft.approvedUnderstanding,
		approvedIntent: draft.approvedIntent,
		currentSchema: draft.currentSchema,
		approvedSchema: draft.approvedSchema,
		currentSchemeDescription: draft.currentSchemeDescription,
		approvedSchemeDescription: draft.approvedSchemeDescription,
		solverModel: draft.solverModel,
		latestRevision: latestRevision
			? {
				revisionIndex: latestRevision.revisionIndex,
				schemaVersion: latestRevision.schemaVersion ?? draft.schemaVersion ?? '1.0',
				userNotes: latestRevision.userNotes,
				understanding: latestRevision.understanding,
				intent: latestRevision.intent,
				schema: latestRevision.schema,
				schemeDescription: latestRevision.schemeDescription,
				assumptions: latestRevision.assumptions,
				ambiguities: latestRevision.ambiguities,
				createdAt: latestRevision.createdAt
			}
			: null,
		createdAt: draft.createdAt,
		updatedAt: draft.updatedAt
	});
};
