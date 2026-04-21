import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { runPipelineWithApprovedSchema, type PipelineStatus } from '$lib/server/ai/pipeline.js';
import {
	isModelPreference,
	normalizeModelPreference,
	toForcedModel
} from '$lib/server/ai/model-preference.js';
import type { SchemaAny } from '$lib/schema/schema-any.js';
import { validateSchemaAny } from '$lib/schema/schema-any.js';
import { compileSchemeIntent } from '$lib/schema/compiler.js';
import { validateSchemeIntent } from '$lib/schema/intent.js';
import {
	schemeUnderstandingFromIntent,
	validateSchemeUnderstanding
} from '$lib/schema/understanding.js';
import { buildAdaptiveSchemeDescription } from '$lib/server/schema/description.js';
import { buildSolverModelFromSchema, type SolverModelV1 } from '$lib/solver/model.js';
import {
	acquireChatProcessing,
	ChatProcessingConflictError,
	type ChatProcessingHandle
} from '$lib/server/chat-processing.js';
import { canConfirmStatus, loadGeminiHistory, logSchemaCheck } from '$lib/server/schema/flow.js';

function isResultEvent(event: PipelineStatus): event is Extract<PipelineStatus, { type: 'result' }> {
	return event.type === 'result';
}

async function runSolveWithGate(params: {
	userMessage: string;
	approvedSchema: SchemaAny;
	approvedSchemeDescription?: string | null;
	solverModel?: SolverModelV1;
	revisionNotes: string[];
	history: Awaited<ReturnType<typeof loadGeminiHistory>>;
	forcedModel?: string | null;
	onStatus?: (status: string) => void;
}): Promise<Extract<PipelineStatus, { type: 'result' }>> {
	let lastError: string | null = null;
	let finalResult: Extract<PipelineStatus, { type: 'result' }> | null = null;

	await runPipelineWithApprovedSchema(
		{
			userMessage: params.userMessage,
			approvedSchema: params.approvedSchema,
			approvedSchemeDescription: params.approvedSchemeDescription,
			solverModel: params.solverModel,
			revisionNotes: params.revisionNotes
		},
		params.history,
		(event) => {
			if (event.type === 'status') params.onStatus?.(event.message);
			if (event.type === 'error') lastError = event.message;
			if (isResultEvent(event)) finalResult = event;
		},
		undefined,
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
	approvedSchema: SchemaAny;
	approvedSchemeDescription?: string | null;
	solverModel?: SolverModelV1;
	schemaVersion: string;
	revisionNotes: string[];
	forcedModel?: string | null;
	startedAt: number;
	processingHandle: ChatProcessingHandle;
}): void {
	if (schemaSolveTasks.has(params.draftId)) {
		logSchemaCheck('confirm.background_skip_existing', { draftId: params.draftId });
		params.processingHandle.release();
		return;
	}

	const db = prisma as any;
	const task = (async () => {
		try {
			const history = await loadGeminiHistory(params.chatId);
			const resultEvent = await runSolveWithGate({
				userMessage: params.userMessage,
				approvedSchema: params.approvedSchema,
				approvedSchemeDescription: params.approvedSchemeDescription,
				solverModel: params.solverModel,
				revisionNotes: params.revisionNotes,
				history,
				forcedModel: params.forcedModel,
				onStatus: (status) => params.processingHandle.updateStatus(status)
			});
			params.processingHandle.updateStatus('Сохраняю результат решения...');
			logSchemaCheck('confirm.pipeline_result', {
				draftId: params.draftId,
				contentLength: resultEvent.content.length,
				graphs: resultEvent.graphData?.length ?? 0,
				exactAnswers: resultEvent.exactAnswers?.length ?? 0,
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
						exactAnswers: resultEvent.exactAnswers ? JSON.stringify(resultEvent.exactAnswers) : undefined,
						schemaData: resultEvent.schemaData ? JSON.stringify(resultEvent.schemaData) : undefined,
						schemaDescription:
							typeof resultEvent.schemaDescription === 'string'
								? resultEvent.schemaDescription
								: undefined,
						schemaVersion: resultEvent.schemaVersion ?? params.schemaVersion,
						usedModels: resultEvent.usedModels ? JSON.stringify(resultEvent.usedModels) : undefined
					}
				});
			});
		} catch (err) {
			const messageText = err instanceof Error ? err.message : String(err);
			params.processingHandle.updateStatus('Решение завершилось с ошибкой');
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
			params.processingHandle.release();
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

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	const db = prisma as any;
	const startedAt = Date.now();
	logSchemaCheck('confirm.request', { userId: locals.user.id, draftId: params.draftId });
	let requestedModelPreference: string | undefined;
	try {
		const body = (await request.json()) as { modelPreference?: string };
		requestedModelPreference = body.modelPreference;
	} catch {
		// Backwards-compatible empty body.
	}
	if (requestedModelPreference !== undefined && !isModelPreference(requestedModelPreference)) {
		return error(400, `Unsupported modelPreference: ${String(requestedModelPreference)}`);
	}

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

	let processingHandle: ChatProcessingHandle;
	try {
		processingHandle = acquireChatProcessing({
			userId: locals.user.id,
			chatId: draft.chatId,
			kind: 'schema_confirm',
			statusMessage: 'Solving using approved scheme...'
		});
	} catch (processingError) {
		if (processingError instanceof ChatProcessingConflictError) {
			return error(429, 'Another task is already being processed. Please wait for completion.');
		}
		throw processingError;
	}

	let releaseProcessing = true;
	try {
		let approvedIntent: unknown = null;
		let approvedUnderstanding: unknown = null;
		let approvedSchemaValue: SchemaAny | null = null;
		let approvedSchemaVersion = '2.0';

		if (draft.currentIntent) {
			const intentValidation = validateSchemeIntent(draft.currentIntent);
			if (intentValidation.ok && intentValidation.value) {
				try {
					const compiled = compileSchemeIntent(intentValidation.value);
					approvedIntent = intentValidation.value;
					approvedUnderstanding = schemeUnderstandingFromIntent(intentValidation.value);
					approvedSchemaValue = compiled.schemaData;
					approvedSchemaVersion = '2.0';
					logSchemaCheck('confirm.intent_compiled', {
						draftId: draft.id,
						compileWarnings: compiled.warnings.length
					});
				} catch (compileErr) {
					logSchemaCheck('confirm.intent_compile_failed', {
						draftId: draft.id,
						error: compileErr instanceof Error ? compileErr.message : String(compileErr)
					});
				}
			} else {
				logSchemaCheck('confirm.intent_invalid', {
					draftId: draft.id,
					errors: intentValidation.errors
				});
			}
		}

		if (!approvedUnderstanding && draft.currentUnderstanding) {
			const understandingValidation = validateSchemeUnderstanding(draft.currentUnderstanding);
			if (understandingValidation.ok && understandingValidation.value) {
				approvedUnderstanding = understandingValidation.value;
			}
		}

		if (!approvedSchemaValue) {
			const schemaValidation = validateSchemaAny(draft.currentSchema);
			if (!schemaValidation.ok || !schemaValidation.value) {
				logSchemaCheck('confirm.schema_invalid', {
					draftId: draft.id,
					errors: schemaValidation.errors
				});
				return error(422, `Approved schema validation failed: ${schemaValidation.errors.join('; ')}`);
			}
			approvedSchemaValue = schemaValidation.value;
			approvedSchemaVersion = schemaValidation.version ?? '2.0';
		}
		if (!approvedSchemaValue) {
			return error(422, 'Approved schema is missing after confirmation checks');
		}

		let solverModel: SolverModelV1;
		try {
			const built = buildSolverModelFromSchema(approvedSchemaValue);
			solverModel = built.solverModel;
			if (built.warnings.length > 0) {
				logSchemaCheck('confirm.solver_model_warnings', {
					draftId: draft.id,
					warnings: built.warnings.slice(0, 6)
				});
			}
		} catch (buildErr) {
			const messageText = buildErr instanceof Error ? buildErr.message : String(buildErr);
			logSchemaCheck('confirm.solver_model_failed', {
				draftId: draft.id,
				error: messageText
			});
			return error(422, `Solver model build failed: ${messageText}`);
		}

		const effectiveModelPreference =
			requestedModelPreference !== undefined
				? normalizeModelPreference(requestedModelPreference)
				: normalizeModelPreference(draft.chat.modelPreference);
		const forcedModel = toForcedModel(effectiveModelPreference);
		logSchemaCheck('confirm.model_resolved', {
			draftId: draft.id,
			chatId: draft.chatId,
			modelPreference: draft.chat.modelPreference,
			requestModelPreference: requestedModelPreference ?? null,
			effectiveModelPreference,
			forcedModel
		});
		const revisionNotes = draft.revisions
			.map((revision: { userNotes?: string | null }) => revision.userNotes?.trim())
			.filter((note: string | undefined): note is string => Boolean(note));
		let approvedSchemeDescription =
			typeof draft.currentSchemeDescription === 'string' ? draft.currentSchemeDescription.trim() : '';
		if (!approvedSchemeDescription && approvedUnderstanding) {
			const understandingValidation = validateSchemeUnderstanding(approvedUnderstanding);
			if (understandingValidation.ok && understandingValidation.value) {
				const descriptionResult = await buildAdaptiveSchemeDescription({
					schema: approvedSchemaValue,
					language: understandingValidation.value.source.language,
					understanding: understandingValidation.value,
					assumptions: understandingValidation.value.assumptions,
					forcedModel,
					fastMode: true
				});
				approvedSchemeDescription = descriptionResult.description;
			}
		}

		await db.taskDraft.update({
			where: { id: draft.id },
			data: {
				approvedUnderstanding,
				approvedIntent,
				approvedSchema: approvedSchemaValue,
				approvedSchemeDescription: approvedSchemeDescription || null,
				solverModel,
				status: 'SOLVING',
				schemaVersion: approvedSchemaVersion
			}
		});
		logSchemaCheck('confirm.approved_and_solving', {
			draftId: draft.id,
			revisionNotes: revisionNotes.length,
			schemaVersion: approvedSchemaVersion
		});

		processingHandle.updateStatus('Solve started. Waiting for result...');
		launchSchemaSolveInBackground({
			draftId: draft.id,
			chatId: draft.chatId,
			userMessage: draft.originalPrompt,
			approvedSchema: approvedSchemaValue,
			approvedSchemeDescription: approvedSchemeDescription || null,
			solverModel,
			schemaVersion: approvedSchemaVersion,
			revisionNotes,
			forcedModel,
			startedAt,
			processingHandle
		});
		releaseProcessing = false;

		return json({
			draftId: draft.id,
			status: 'SOLVING',
			accepted: true
		});
	} finally {
		if (releaseProcessing) {
			processingHandle.release();
		}
	}
};
