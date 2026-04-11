import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { runPipelineWithApprovedSchema, type PipelineStatus } from '$lib/server/ai/pipeline.js';
import type { SchemaAny } from '$lib/schema/schema-any.js';
import { validateSchemaAny } from '$lib/schema/schema-any.js';
import { canConfirmStatus, loadGeminiHistory, logSchemaCheck, parseImageData } from '$lib/server/schema/flow.js';

function isResultEvent(event: PipelineStatus): event is Extract<PipelineStatus, { type: 'result' }> {
	return event.type === 'result';
}

async function runSolveWithGate(params: {
	userMessage: string;
	approvedSchema: SchemaAny;
	revisionNotes: string[];
	history: Awaited<ReturnType<typeof loadGeminiHistory>>;
	imageData?: { base64: string; mimeType: string };
	forcedModel?: string | null;
}): Promise<Extract<PipelineStatus, { type: 'result' }>> {
	let lastError: string | null = null;
	let finalResult: Extract<PipelineStatus, { type: 'result' }> | null = null;

	await runPipelineWithApprovedSchema(
		{
			userMessage: params.userMessage,
			approvedSchema: params.approvedSchema,
			revisionNotes: params.revisionNotes
		},
		params.history,
		(event) => {
			if (event.type === 'error') lastError = event.message;
			if (isResultEvent(event)) finalResult = event;
		},
		params.imageData,
		params.forcedModel
	);

	if (!finalResult) {
		throw new Error(lastError ?? 'Solve pipeline finished without result');
	}

	return finalResult;
}

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	const db = prisma as any;
	const startedAt = Date.now();
	logSchemaCheck('confirm.request', { userId: locals.user.id, draftId: params.draftId });

	const draft = await db.taskDraft.findUnique({
		where: { id: params.draftId },
		include: {
			chat: {
				select: { id: true, userId: true, modelPreference: true }
			},
			revisions: {
				orderBy: { revisionIndex: 'asc' },
				select: { userNotes: true }
			}
		}
	});

	if (!draft) return error(404, 'Draft not found');
	if (draft.userId !== locals.user.id || draft.chat.userId !== locals.user.id) return error(403, 'Forbidden');
	logSchemaCheck('confirm.draft_loaded', {
		draftId: draft.id,
		chatId: draft.chatId,
		status: draft.status,
		revisionCount: draft.revisionCount,
		modelPreference: draft.chat.modelPreference
	});

	if (draft.status === 'SOLVED') {
		logSchemaCheck('confirm.already_solved', { draftId: draft.id });
		return json({ status: 'SOLVED', draftId: draft.id, alreadySolved: true });
	}
	if (draft.status === 'SOLVING' || draft.status === 'SCHEMA_APPROVED') {
		logSchemaCheck('confirm.already_solving', { draftId: draft.id, status: draft.status });
		return error(409, 'Draft is already being solved');
	}
	if (!canConfirmStatus(draft.status)) {
		logSchemaCheck('confirm.invalid_status', { draftId: draft.id, status: draft.status });
		return error(409, `Draft status does not allow confirmation: ${draft.status}`);
	}
	if (!draft.currentSchema) {
		logSchemaCheck('confirm.no_schema', { draftId: draft.id });
		return error(409, 'No current schema to approve');
	}

	const schemaValidation = validateSchemaAny(draft.currentSchema);
	if (!schemaValidation.ok || !schemaValidation.value) {
		logSchemaCheck('confirm.schema_invalid', { draftId: draft.id, errors: schemaValidation.errors });
		return error(422, `Approved schema validation failed: ${schemaValidation.errors.join('; ')}`);
	}

	const forcedModel = draft.chat.modelPreference === 'auto' ? null : draft.chat.modelPreference;
	const revisionNotes = draft.revisions
		.map((revision: { userNotes?: string | null }) => revision.userNotes?.trim())
		.filter((note: string | undefined): note is string => Boolean(note));

	await db.taskDraft.update({
		where: { id: draft.id },
		data: {
			approvedSchema: schemaValidation.value,
			status: 'SOLVING',
			schemaVersion: schemaValidation.version ?? '2.0'
		}
	});
	logSchemaCheck('confirm.approved_and_solving', {
		draftId: draft.id,
		revisionNotes: revisionNotes.length,
		schemaVersion: schemaValidation.version ?? '2.0'
	});

	const history = await loadGeminiHistory(draft.chatId);
	const imageData = parseImageData(draft.originalImageData);

	try {
		const resultEvent = await runSolveWithGate({
			userMessage: draft.originalPrompt,
			approvedSchema: schemaValidation.value,
			revisionNotes,
			history,
			imageData,
			forcedModel
		});
		logSchemaCheck('confirm.pipeline_result', {
			draftId: draft.id,
			contentLength: resultEvent.content.length,
			graphs: resultEvent.graphData?.length ?? 0,
			modelEntries: resultEvent.usedModels?.length ?? 0
		});

		const assistantMessage = await db.$transaction(async (txRaw: any) => {
			const tx = txRaw as any;
			await tx.taskDraft.update({
				where: { id: draft.id },
				data: { status: 'SOLVED' }
			});

			return tx.message.create({
				data: {
					chatId: draft.chatId,
					draftId: draft.id,
					role: 'ASSISTANT',
					content: resultEvent.content,
					generatedCode: resultEvent.generatedCode ?? null,
					executionLogs: resultEvent.executionLogs ?? null,
					graphData: resultEvent.graphData ? JSON.stringify(resultEvent.graphData) : undefined,
					schemaVersion: schemaValidation.version ?? '2.0',
					usedModels: resultEvent.usedModels ? JSON.stringify(resultEvent.usedModels) : undefined
				}
			});
		});

		return json({
			draftId: draft.id,
			status: 'SOLVED',
			result: {
				id: assistantMessage.id,
				content: assistantMessage.content,
				graphData: resultEvent.graphData ?? null,
				usedModels: resultEvent.usedModels ?? null,
				createdAt: assistantMessage.createdAt
			}
		});
	} catch (err) {
		const messageText = err instanceof Error ? err.message : String(err);
		logSchemaCheck('confirm.failed', {
			draftId: draft.id,
			error: messageText,
			durationMs: Date.now() - startedAt
		});
		await db.taskDraft.update({ where: { id: draft.id }, data: { status: 'FAILED' } }).catch(() => undefined);
		await db.message
			.create({
				data: {
					chatId: draft.chatId,
					draftId: draft.id,
					role: 'ASSISTANT',
					content: `Schema-confirmed solve failed: ${messageText}`,
					schemaVersion: schemaValidation.version ?? '2.0'
				}
			})
			.catch(() => undefined);
		return error(500, `Failed to solve with approved schema: ${messageText}`);
	} finally {
		logSchemaCheck('confirm.finished', {
			draftId: params.draftId,
			durationMs: Date.now() - startedAt
		});
	}
};
