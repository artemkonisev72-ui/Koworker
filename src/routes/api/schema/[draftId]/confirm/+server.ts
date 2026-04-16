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

const globalSolveState = globalThis as unknown as {
	_schemaSolveTasks?: Map<string, Promise<void>>;
};
const schemaSolveTasks = globalSolveState._schemaSolveTasks ?? new Map<string, Promise<void>>();
if (!globalSolveState._schemaSolveTasks) {
	globalSolveState._schemaSolveTasks = schemaSolveTasks;
}

function launchSchemaSolveInBackground(params: {
	draftId: string;
	chatId: string;
	userMessage: string;
	originalImageData?: string | null;
	approvedSchema: SchemaAny;
	schemaVersion: string;
	revisionNotes: string[];
	forcedModel?: string | null;
	startedAt: number;
}): void {
	if (schemaSolveTasks.has(params.draftId)) {
		logSchemaCheck('confirm.background_skip_existing', { draftId: params.draftId });
		return;
	}

	const db = prisma as any;
	const task = (async () => {
		try {
			const history = await loadGeminiHistory(params.chatId);
			const imageData = parseImageData(params.originalImageData);
			const resultEvent = await runSolveWithGate({
				userMessage: params.userMessage,
				approvedSchema: params.approvedSchema,
				revisionNotes: params.revisionNotes,
				history,
				imageData,
				forcedModel: params.forcedModel
			});
			logSchemaCheck('confirm.pipeline_result', {
				draftId: params.draftId,
				contentLength: resultEvent.content.length,
				graphs: resultEvent.graphData?.length ?? 0,
				modelEntries: resultEvent.usedModels?.length ?? 0
			});

			await db.$transaction(async (txRaw: any) => {
				const tx = txRaw as any;
				await tx.taskDraft.update({
					where: { id: params.draftId },
					data: { status: 'SOLVED' }
				});

				await tx.message.create({
					data: {
						chatId: params.chatId,
						draftId: params.draftId,
						role: 'ASSISTANT',
						content: resultEvent.content,
						generatedCode: resultEvent.generatedCode ?? null,
						executionLogs: resultEvent.executionLogs ?? null,
						graphData: resultEvent.graphData ? JSON.stringify(resultEvent.graphData) : undefined,
						schemaData: resultEvent.schemaData ? JSON.stringify(resultEvent.schemaData) : undefined,
						schemaVersion: resultEvent.schemaVersion ?? params.schemaVersion,
						usedModels: resultEvent.usedModels ? JSON.stringify(resultEvent.usedModels) : undefined
					}
				});
			});
		} catch (err) {
			const messageText = err instanceof Error ? err.message : String(err);
			logSchemaCheck('confirm.failed', {
				draftId: params.draftId,
				error: messageText,
				durationMs: Date.now() - params.startedAt
			});
			await db.taskDraft.update({ where: { id: params.draftId }, data: { status: 'FAILED' } }).catch(() => undefined);
			await db.message
				.create({
					data: {
						chatId: params.chatId,
						draftId: params.draftId,
						role: 'ASSISTANT',
						content: `Schema-confirmed solve failed: ${messageText}`,
						schemaVersion: params.schemaVersion
					}
				})
				.catch(() => undefined);
		} finally {
			logSchemaCheck('confirm.finished', {
				draftId: params.draftId,
				durationMs: Date.now() - params.startedAt
			});
		}
	})();

	schemaSolveTasks.set(params.draftId, task);
	void task.finally(() => {
		schemaSolveTasks.delete(params.draftId);
	});
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
		return json({ draftId: draft.id, status: 'SOLVING', alreadySolving: true });
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

	launchSchemaSolveInBackground({
		draftId: draft.id,
		chatId: draft.chatId,
		userMessage: draft.originalPrompt,
		originalImageData: draft.originalImageData,
		approvedSchema: schemaValidation.value,
		schemaVersion: schemaValidation.version ?? '2.0',
		revisionNotes,
		forcedModel,
		startedAt
	});

	return json({
		draftId: draft.id,
		status: 'SOLVING',
		accepted: true
	});
};
