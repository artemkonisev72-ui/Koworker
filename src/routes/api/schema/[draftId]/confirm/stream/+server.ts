import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import {
	runPipelineWithApprovedSchema,
	type PipelineStatus,
	type SandboxExecutionMeta
} from '$lib/server/ai/pipeline.js';
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
import { canConfirmStatus, loadGeminiHistory, logSchemaCheck, parseImageData } from '$lib/server/schema/flow.js';
import {
	ClientSandboxResultError,
	cancelClientSandboxRequest,
	createClientSandboxRequest
} from '$lib/server/sandbox/client-bridge.js';
import { executeFallbackSandbox } from '$lib/server/sandbox/fallback-executor.js';
import { SandboxError } from '$lib/server/sandbox/worker-pool.js';

const CLIENT_SANDBOX_TIMEOUT_MS = 20_000;
const CLIENT_SANDBOX_EXECUTION_TIMEOUT_MS = 18_000;
const CLIENT_FALLBACK_ERROR_KINDS = new Set([
	'unsupported',
	'wasm_oom',
	'timeout',
	'worker_crash',
	'warmup_failed'
]);

type SandboxRequestEvent = {
	type: 'sandbox_request';
	requestId: string;
	attempt: number;
	code: string;
	timeoutMs: number;
};

type OutboundEvent = PipelineStatus | SandboxRequestEvent;

function isResultEvent(event: PipelineStatus): event is Extract<PipelineStatus, { type: 'result' }> {
	return event.type === 'result';
}

function createSseResponse(stream: ReadableStream): Response {
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
}

async function rollbackSolveToAwaitingReview(params: {
	db: any;
	draftId: string;
	chatId: string;
	schemaVersion: string;
	errorMessage: string;
}): Promise<void> {
	await params.db.taskDraft
		.update({
			where: { id: params.draftId },
			data: { status: 'AWAITING_REVIEW' }
		})
		.catch(() => undefined);

	await params.db.message
		.create({
			data: {
				chatId: params.chatId,
				draftId: params.draftId,
				role: 'ASSISTANT',
				content: `Schema-confirmed solve failed: ${params.errorMessage}`,
				schemaVersion: params.schemaVersion
			}
		})
		.catch(() => undefined);
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	const db = prisma as any;
	const userId = locals.user.id;

	let requestedModelPreference: string | undefined;
	try {
		const body = (await request.json()) as { modelPreference?: string };
		requestedModelPreference = body.modelPreference;
	} catch {
		// Backward compatible empty body.
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
	if (draft.userId !== userId || draft.chat.userId !== userId) return error(403, 'Forbidden');
	if (draft.status === 'SOLVING') return error(409, 'Draft is already solving');
	if (draft.status === 'SOLVED') return error(409, 'Draft is already solved');
	if (!canConfirmStatus(draft.status)) {
		return error(409, `Draft status does not allow confirmation: ${draft.status}`);
	}
	if (!draft.currentSchema) return error(409, 'No current schema to approve');

	let processingHandle: ChatProcessingHandle;
	try {
		processingHandle = acquireChatProcessing({
			userId,
			chatId: draft.chatId,
			kind: 'schema_confirm',
			statusMessage: 'Solving using approved scheme...'
		});
	} catch (processingError) {
		if (processingError instanceof ChatProcessingConflictError) {
			return error(429, 'Другая задача уже обрабатывается. Дождитесь завершения.');
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
				} catch (compileErr) {
					logSchemaCheck('confirm_stream.intent_compile_failed', {
						draftId: draft.id,
						error: compileErr instanceof Error ? compileErr.message : String(compileErr)
					});
				}
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
				logSchemaCheck('confirm_stream.solver_model_warnings', {
					draftId: draft.id,
					warnings: built.warnings.slice(0, 6)
				});
			}
		} catch (buildErr) {
			const messageText = buildErr instanceof Error ? buildErr.message : String(buildErr);
			return error(422, `Solver model build failed: ${messageText}`);
		}

		const effectiveModelPreference =
			requestedModelPreference !== undefined
				? normalizeModelPreference(requestedModelPreference)
				: normalizeModelPreference(draft.chat.modelPreference);
		const forcedModel = toForcedModel(effectiveModelPreference);
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

		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				let streamClosed = false;
				let pingInterval: ReturnType<typeof setInterval> | null = null;
				const pendingSandboxRequests = new Set<string>();
				let solveSucceeded = false;
				let rollbackPerformed = false;

				function safeEnqueue(chunk: Uint8Array): boolean {
					if (streamClosed || request.signal.aborted) {
						streamClosed = true;
						return false;
					}
					try {
						controller.enqueue(chunk);
						return true;
					} catch {
						streamClosed = true;
						return false;
					}
				}

				function send(event: OutboundEvent): boolean {
					const payload = `data: ${JSON.stringify(event)}\n\n`;
					return safeEnqueue(encoder.encode(payload));
				}

				function sendDone(): void {
					if (streamClosed) return;
					safeEnqueue(encoder.encode('data: [DONE]\n\n'));
					try {
						controller.close();
					} catch {
						// ignore close races
					} finally {
						streamClosed = true;
					}
				}

				async function rollbackCurrentSolve(errorMessage: string): Promise<void> {
					if (rollbackPerformed || solveSucceeded) return;
					rollbackPerformed = true;
					await rollbackSolveToAwaitingReview({
						db,
						draftId: draft.id,
						chatId: draft.chatId,
						schemaVersion: approvedSchemaVersion,
						errorMessage
					});
				}

				async function requestSandboxExecution(
					code: string,
					meta: SandboxExecutionMeta
				): Promise<{ stdout: string }> {
					const pending = createClientSandboxRequest({
						userId,
						timeoutMs: CLIENT_SANDBOX_TIMEOUT_MS
					});
					pendingSandboxRequests.add(pending.requestId);
					console.info('[SandboxExecution] request source=client', {
						route: 'schema_confirm_stream',
						chatId: draft.chatId,
						draftId: draft.id,
						userId,
						requestId: pending.requestId,
						attempt: meta.attempt,
						codeLength: code.length
					});

					const delivered = send({
						type: 'sandbox_request',
						requestId: pending.requestId,
						attempt: meta.attempt,
						code,
						timeoutMs: CLIENT_SANDBOX_EXECUTION_TIMEOUT_MS
					});
					if (!delivered) {
						console.warn('[SandboxExecution] client request not delivered', {
							route: 'schema_confirm_stream',
							chatId: draft.chatId,
							draftId: draft.id,
							userId,
							requestId: pending.requestId,
							attempt: meta.attempt
						});
						pending.cancel('SSE stream closed before sandbox execution request');
						throw new SandboxError('Client disconnected before sandbox execution request');
					}

					try {
						const result = await pending.promise;
						console.info('[SandboxExecution] source=client', {
							route: 'schema_confirm_stream',
							chatId: draft.chatId,
							draftId: draft.id,
							userId,
							requestId: pending.requestId,
							attempt: meta.attempt,
							stdoutLength: result.stdout.length
						});
						return result;
					} catch (executionError) {
						if (executionError instanceof ClientSandboxResultError) {
							if (CLIENT_FALLBACK_ERROR_KINDS.has(executionError.kind)) {
								console.warn('[SandboxExecution] client failed; falling back to server', {
									route: 'schema_confirm_stream',
									chatId: draft.chatId,
									draftId: draft.id,
									userId,
									requestId: pending.requestId,
									attempt: meta.attempt,
									errorKind: executionError.kind,
									message: executionError.message
								});
								return executeFallbackSandbox(code);
							}
							throw new SandboxError(executionError.message);
						}
						if (executionError instanceof SandboxError) throw executionError;
						throw new SandboxError(
							executionError instanceof Error ? executionError.message : String(executionError)
						);
					} finally {
						pendingSandboxRequests.delete(pending.requestId);
					}
				}

				request.signal.addEventListener(
					'abort',
					() => {
						streamClosed = true;
						if (pingInterval) {
							clearInterval(pingInterval);
							pingInterval = null;
						}
						for (const requestId of pendingSandboxRequests) {
							cancelClientSandboxRequest(requestId, 'Schema confirm stream aborted');
						}
						pendingSandboxRequests.clear();
					},
					{ once: true }
				);

				send({ type: 'status', message: 'Solve started. Waiting for result...' });
				pingInterval = setInterval(() => {
					send({ type: 'ping' });
				}, 5000);

				void (async () => {
					try {
						const history = await loadGeminiHistory(draft.chatId);
						await runPipelineWithApprovedSchema(
							{
								userMessage: draft.originalPrompt,
								approvedSchema: approvedSchemaValue!,
								approvedSchemeDescription: approvedSchemeDescription || null,
								solverModel,
								revisionNotes
							},
							history,
							async (event) => {
								if (event.type === 'status') {
									processingHandle.updateStatus(event.message);
									send(event);
									return;
								}

								if (event.type === 'error') {
									await rollbackCurrentSolve(event.message ?? 'Schema solve failed');
									send(event);
									return;
								}

								if (!isResultEvent(event)) {
									send(event);
									return;
								}

								const assistantMessage = await db.message.create({
									data: {
										chatId: draft.chatId,
										draftId: draft.id,
										role: 'ASSISTANT',
										content: event.content,
										generatedCode: event.generatedCode ?? null,
										executionLogs: event.executionLogs ?? null,
										graphData: event.graphData ? JSON.stringify(event.graphData) : undefined,
										exactAnswers: event.exactAnswers ? JSON.stringify(event.exactAnswers) : undefined,
										schemaData: event.schemaData ? JSON.stringify(event.schemaData) : undefined,
										schemaDescription:
											typeof event.schemaDescription === 'string' ? event.schemaDescription : undefined,
										schemaVersion: event.schemaVersion ?? approvedSchemaVersion,
										usedModels: event.usedModels ? JSON.stringify(event.usedModels) : undefined
									}
								});

								await db.taskDraft.update({
									where: { id: draft.id },
									data: { status: 'SOLVED' }
								});
								solveSucceeded = true;

								send({
									...event,
									messageId: assistantMessage.id
								});
							},
							parseImageData(draft.originalImageData),
							forcedModel,
							{ sandboxExecutor: requestSandboxExecution }
						);
					} catch (pipelineError) {
						const messageText = pipelineError instanceof Error ? pipelineError.message : String(pipelineError);
						await rollbackCurrentSolve(messageText);
						send({ type: 'error', message: messageText });
					} finally {
						if (pingInterval) {
							clearInterval(pingInterval);
							pingInterval = null;
						}
						for (const requestId of pendingSandboxRequests) {
							cancelClientSandboxRequest(requestId, 'Schema confirm stream finished');
						}
						pendingSandboxRequests.clear();
						processingHandle.release();
						sendDone();
					}
				})();
			}
		});

		releaseProcessing = false;
		return createSseResponse(stream);
	} finally {
		if (releaseProcessing) {
			processingHandle.release();
		}
	}
};
