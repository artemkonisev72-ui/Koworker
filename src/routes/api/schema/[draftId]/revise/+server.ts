import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { reviseSchema } from '$lib/server/ai/gemini.js';
import type { SchemaData } from '$lib/schema/schema-data.js';
import { validateSchemaData } from '$lib/schema/schema-data.js';
import {
	formatSchemaAssistantContent,
	isReviewableStatus,
	loadGeminiHistory,
	validateRevisionNotes
} from '$lib/server/schema/flow.js';

interface ReviseBody {
	notes?: string;
}

export const POST: RequestHandler = async ({ locals, request, params }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	const db = prisma as any;

	let body: ReviseBody;
	try {
		body = (await request.json()) as ReviseBody;
	} catch {
		return error(400, 'Invalid JSON body');
	}

	const notes = body.notes ?? '';
	const notesError = validateRevisionNotes(notes);
	if (notesError) return error(400, notesError);

	const draft = await db.taskDraft.findUnique({
		where: { id: params.draftId },
		include: {
			chat: {
				select: { id: true, userId: true, modelPreference: true }
			}
		}
	});

	if (!draft) return error(404, 'Draft not found');
	if (draft.userId !== locals.user.id || draft.chat.userId !== locals.user.id) return error(403, 'Forbidden');
	if (!isReviewableStatus(draft.status)) return error(409, `Invalid draft status: ${draft.status}`);
	if (!draft.currentSchema) return error(409, 'Current schema is missing');

	const forcedModel = draft.chat.modelPreference === 'auto' ? null : draft.chat.modelPreference;
	const history = await loadGeminiHistory(draft.chatId);

	await db.message.create({
		data: {
			chatId: draft.chatId,
			draftId: draft.id,
			role: 'USER',
			content: `Schema revision request:\n${notes}`
		}
	});

	try {
		const revised = await reviseSchema(history, {
			originalPrompt: draft.originalPrompt,
			currentSchema: draft.currentSchema as SchemaData,
			revisionNotes: notes,
			forcedModel
		});

		const validation = validateSchemaData(revised.schemaData);
		if (!validation.ok || !validation.value) {
			return error(422, `Revised schema validation failed: ${validation.errors.join('; ')}`);
		}

		const revisionIndex = draft.revisionCount + 1;
		const assistantContent = formatSchemaAssistantContent({
			revisionIndex,
			assumptions: revised.assumptions,
			ambiguities: revised.ambiguities
		});

		const result = await db.$transaction(async (txRaw: any) => {
			const tx = txRaw as any;
			const updatedDraft = await tx.taskDraft.update({
				where: { id: draft.id },
				data: {
					status: 'AWAITING_REVIEW',
					currentSchema: validation.value,
					revisionCount: revisionIndex
				}
			});

			await tx.taskDraftRevision.create({
				data: {
					draftId: draft.id,
					revisionIndex,
					userNotes: notes,
					schema: validation.value,
					assumptions: revised.assumptions
				}
			});

			const assistantMessage = await tx.message.create({
				data: {
					chatId: draft.chatId,
					draftId: draft.id,
					role: 'ASSISTANT',
					content: assistantContent,
					schemaData: JSON.stringify(validation.value),
					usedModels: JSON.stringify(revised.usedModels)
				}
			});

			return { updatedDraft, assistantMessage };
		});

		return json({
			draftId: draft.id,
			status: result.updatedDraft.status,
			revisionIndex,
			schema: validation.value,
			assumptions: revised.assumptions,
			ambiguities: revised.ambiguities,
			assistantMessage: {
				id: result.assistantMessage.id,
				role: result.assistantMessage.role,
				content: result.assistantMessage.content,
				schemaData: validation.value,
				usedModels: revised.usedModels,
				draftId: result.assistantMessage.draftId,
				createdAt: result.assistantMessage.createdAt
			}
		});
	} catch (err) {
		const messageText = err instanceof Error ? err.message : String(err);
		return error(500, `Failed to revise schema: ${messageText}`);
	}
};
