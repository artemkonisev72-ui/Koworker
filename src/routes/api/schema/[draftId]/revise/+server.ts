import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { reviseSchema } from '$lib/server/ai/gemini.js';
import type { SchemaAny } from '$lib/schema/schema-any.js';
import { validateSchemaAny } from '$lib/schema/schema-any.js';
import {
	detectPromptLanguage,
	formatSchemaAssistantContent,
	isReviewableStatus,
	loadGeminiHistory,
	logSchemaCheck,
	validateRevisionNotes
} from '$lib/server/schema/flow.js';

interface ReviseBody {
	notes?: string;
}

export const POST: RequestHandler = async ({ locals, request, params }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	const db = prisma as any;
	const startedAt = Date.now();

	let body: ReviseBody;
	try {
		body = (await request.json()) as ReviseBody;
	} catch {
		logSchemaCheck('revise.invalid_json', { userId: locals.user.id, draftId: params.draftId });
		return error(400, 'Invalid JSON body');
	}

	const notes = body.notes ?? '';
	logSchemaCheck('revise.request', {
		userId: locals.user.id,
		draftId: params.draftId,
		notesLength: notes.length
	});
	const notesError = validateRevisionNotes(notes);
	if (notesError) {
		logSchemaCheck('revise.validation_error', { draftId: params.draftId, reason: notesError });
		return error(400, notesError);
	}

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
	logSchemaCheck('revise.draft_loaded', {
		draftId: draft.id,
		chatId: draft.chatId,
		status: draft.status,
		revisionCount: draft.revisionCount,
		modelPreference: draft.chat.modelPreference
	});

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
			currentSchema: draft.currentSchema as SchemaAny,
			revisionNotes: notes,
			forcedModel
		});
		logSchemaCheck('revise.llm_generated', {
			draftId: draft.id,
			model: revised.model,
			tokens: revised.tokens,
			assumptions: revised.assumptions.length,
			ambiguities: revised.ambiguities.length
		});

		const validation = validateSchemaAny(revised.schemaData);
		if (!validation.ok || !validation.value) {
			logSchemaCheck('revise.schema_invalid', { draftId: draft.id, errors: validation.errors });
			return error(422, `Revised schema validation failed: ${validation.errors.join('; ')}`);
		}

		const revisionIndex = draft.revisionCount + 1;
		const assistantContent = formatSchemaAssistantContent({
			revisionIndex,
			assumptions: revised.assumptions,
			ambiguities: revised.ambiguities,
			language: detectPromptLanguage(`${draft.originalPrompt}\n${notes}`)
		});

		const result = await db.$transaction(async (txRaw: any) => {
			const tx = txRaw as any;
			const updatedDraft = await tx.taskDraft.update({
				where: { id: draft.id },
				data: {
					status: 'AWAITING_REVIEW',
					currentSchema: validation.value,
					schemaVersion: validation.version ?? '2.0',
					revisionCount: revisionIndex
				}
			});

			await tx.taskDraftRevision.create({
				data: {
					draftId: draft.id,
					revisionIndex,
					schemaVersion: validation.version ?? '2.0',
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
					schemaVersion: validation.version ?? '2.0',
					usedModels: JSON.stringify(revised.usedModels)
				}
			});

			return { updatedDraft, assistantMessage };
		});

		return json({
			draftId: draft.id,
			status: result.updatedDraft.status,
			schemaVersion: validation.version ?? '2.0',
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
		logSchemaCheck('revise.failed', {
			draftId: params.draftId,
			error: messageText,
			durationMs: Date.now() - startedAt
		});
		return error(500, `Failed to revise schema: ${messageText}`);
	}
	finally {
		logSchemaCheck('revise.finished', {
			draftId: params.draftId,
			durationMs: Date.now() - startedAt
		});
	}
};

