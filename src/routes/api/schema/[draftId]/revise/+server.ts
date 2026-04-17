import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import {
	repairIntentByIssues,
	repairSchemaByIssues,
	reviseIntent,
	reviseSchema
} from '$lib/server/ai/gemini.js';
import {
	isModelPreference,
	normalizeModelPreference,
	toForcedModel
} from '$lib/server/ai/model-preference.js';
import type { SchemaAny } from '$lib/schema/schema-any.js';
import { validateSchemaAny } from '$lib/schema/schema-any.js';
import { compileSchemeIntent, SchemeIntentCompileError } from '$lib/schema/compiler.js';
import { validateSchemeIntent } from '$lib/schema/intent.js';
import {
	detectPromptLanguage,
	formatSchemaAssistantContent,
	getSchemaLayoutLogDetails,
	isReviewableStatus,
	loadGeminiHistory,
	logSchemaCheck,
	validateRevisionNotes
} from '$lib/server/schema/flow.js';

interface ReviseBody {
	notes?: string;
	modelPreference?: string;
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
	if (body.modelPreference !== undefined && !isModelPreference(body.modelPreference)) {
		return error(400, `Unsupported modelPreference: ${String(body.modelPreference)}`);
	}
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

	const effectiveModelPreference =
		body.modelPreference !== undefined
			? normalizeModelPreference(body.modelPreference)
			: normalizeModelPreference(draft.chat.modelPreference);
	const forcedModel = toForcedModel(effectiveModelPreference);
	logSchemaCheck('revise.model_resolved', {
		draftId: draft.id,
		chatId: draft.chatId,
		modelPreference: draft.chat.modelPreference,
		requestModelPreference: body.modelPreference ?? null,
		effectiveModelPreference,
		forcedModel
	});
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
		const revisionIndex = draft.revisionCount + 1;
		const language = detectPromptLanguage(`${draft.originalPrompt}\n${notes}`);
		const intentValidation = draft.currentIntent ? validateSchemeIntent(draft.currentIntent) : null;
		const canUseIntent = Boolean(intentValidation?.ok && intentValidation.value);

		if (canUseIntent && intentValidation?.value) {
			const revised = await reviseIntent(history, {
				originalPrompt: draft.originalPrompt,
				currentIntent: intentValidation.value,
				revisionNotes: notes,
				forcedModel,
				fastMode: true
			});
			logSchemaCheck('revise.intent_generated', {
				draftId: draft.id,
				model: revised.model,
				tokens: revised.tokens,
				assumptions: revised.assumptions.length,
				ambiguities: revised.ambiguities.length
			});

			let finalRevision = revised;
			let compiledSchema: ReturnType<typeof compileSchemeIntent> | null = null;

			try {
				compiledSchema = compileSchemeIntent(revised.intent);
			} catch (compileErr) {
				if (!(compileErr instanceof SchemeIntentCompileError)) throw compileErr;
				const repairIssues = compileErr.issues.slice(0, 6);
				logSchemaCheck('revise.intent_repair_requested', {
					draftId: draft.id,
					errorCount: compileErr.issues.length,
					issues: repairIssues
				});
				if (repairIssues.length > 0) {
					try {
						const repaired = await repairIntentByIssues(history, {
							originalPrompt: draft.originalPrompt,
							currentIntent: revised.intent,
							issues: repairIssues,
							forcedModel,
							fastMode: true,
							skipSelfCheck: true
						});
						const repairedCompiled = compileSchemeIntent(repaired.intent);
						compiledSchema = repairedCompiled;
						finalRevision = {
							...repaired,
							tokens: revised.tokens + repaired.tokens,
							usedModels: [...revised.usedModels, ...repaired.usedModels],
							assumptions:
								repaired.assumptions.length > 0 ? repaired.assumptions : revised.assumptions,
							ambiguities:
								repaired.ambiguities.length > 0 ? repaired.ambiguities : revised.ambiguities
						};
						logSchemaCheck('revise.intent_repair_applied', {
							draftId: draft.id,
							fixed: true,
							compileWarnings: repairedCompiled.warnings.length
						});
					} catch (repairErr) {
						logSchemaCheck('revise.intent_repair_failed', {
							draftId: draft.id,
							error: repairErr instanceof Error ? repairErr.message : String(repairErr)
						});
					}
				}
			}

			if (!compiledSchema) {
				return error(422, 'Intent compilation failed during revision');
			}

			const finalValidation = validateSchemaAny(compiledSchema.schemaData);
			if (!finalValidation.ok || !finalValidation.value) {
				logSchemaCheck('revise.schema_invalid', { draftId: draft.id, errors: finalValidation.errors });
				return error(422, `Revised schema validation failed: ${finalValidation.errors.join('; ')}`);
			}

			const layoutDetails = getSchemaLayoutLogDetails(finalValidation.value);
			if (layoutDetails) {
				logSchemaCheck('revise.layout_metrics', {
					draftId: draft.id,
					...layoutDetails,
					layoutAutoCorrected: (finalValidation.value as any)?.meta?.layoutAutoCorrected === true,
					layoutCorrections: Array.isArray((finalValidation.value as any)?.meta?.layoutCorrections)
						? (finalValidation.value as any).meta.layoutCorrections
						: []
				});
			}

			const assistantContent = formatSchemaAssistantContent({
				revisionIndex,
				assumptions: finalRevision.assumptions,
				ambiguities: finalRevision.ambiguities,
				language
			});

			const result = await db.$transaction(async (txRaw: any) => {
				const tx = txRaw as any;
				const updatedDraft = await tx.taskDraft.update({
					where: { id: draft.id },
					data: {
						status: 'AWAITING_REVIEW',
						currentIntent: finalRevision.intent,
						currentSchema: finalValidation.value,
						schemaVersion: finalValidation.version ?? '2.0',
						revisionCount: revisionIndex
					}
				});

				await tx.taskDraftRevision.create({
					data: {
						draftId: draft.id,
						revisionIndex,
						schemaVersion: finalValidation.version ?? '2.0',
						userNotes: notes,
						intent: finalRevision.intent,
						schema: finalValidation.value,
						assumptions: finalRevision.assumptions,
						ambiguities: finalRevision.ambiguities
					}
				});

				const assistantMessage = await tx.message.create({
					data: {
						chatId: draft.chatId,
						draftId: draft.id,
						role: 'ASSISTANT',
						content: assistantContent,
						schemaData: JSON.stringify(finalValidation.value),
						schemaVersion: finalValidation.version ?? '2.0',
						usedModels: JSON.stringify(finalRevision.usedModels)
					}
				});

				return { updatedDraft, assistantMessage };
			});

			return json({
				draftId: draft.id,
				status: result.updatedDraft.status,
				schemaVersion: finalValidation.version ?? '2.0',
				revisionIndex,
				schema: finalValidation.value,
				assumptions: finalRevision.assumptions,
				ambiguities: finalRevision.ambiguities,
				assistantMessage: {
					id: result.assistantMessage.id,
					role: result.assistantMessage.role,
					content: result.assistantMessage.content,
					schemaData: finalValidation.value,
					usedModels: finalRevision.usedModels,
					draftId: result.assistantMessage.draftId,
					createdAt: result.assistantMessage.createdAt
				}
			});
		}

		logSchemaCheck('revise.legacy_fallback', {
			draftId: draft.id,
			reason: intentValidation?.ok === false ? 'invalid_current_intent' : 'missing_current_intent'
		});
		const revised = await reviseSchema(history, {
			originalPrompt: draft.originalPrompt,
			currentSchema: draft.currentSchema as SchemaAny,
			revisionNotes: notes,
			forcedModel,
			fastMode: true
		});
		logSchemaCheck('revise.llm_generated', {
			draftId: draft.id,
			model: revised.model,
			tokens: revised.tokens,
			assumptions: revised.assumptions.length,
			ambiguities: revised.ambiguities.length
		});

		let finalRevision = revised;
		let finalValidation = validateSchemaAny(revised.schemaData);

		if (!finalValidation.ok || !finalValidation.value) {
			const repairIssues = finalValidation.errors.slice(0, 6);
			logSchemaCheck('revise.repair_requested', {
				draftId: draft.id,
				reason: 'initial_validation_failed',
				errorCount: finalValidation.errors.length,
				issues: repairIssues
			});
			try {
				const repaired = await repairSchemaByIssues(history, {
					originalPrompt: draft.originalPrompt,
					currentSchema: revised.schemaData as SchemaAny,
					issues: repairIssues,
					forcedModel,
					fastMode: true,
					skipSelfCheck: true
				});
				const repairedValidation = validateSchemaAny(repaired.schemaData);
				if (repairedValidation.ok && repairedValidation.value) {
					finalValidation = repairedValidation;
					finalRevision = {
						...repaired,
						tokens: revised.tokens + repaired.tokens,
						usedModels: [...revised.usedModels, ...repaired.usedModels],
						assumptions: repaired.assumptions.length > 0 ? repaired.assumptions : revised.assumptions,
						ambiguities: repaired.ambiguities.length > 0 ? repaired.ambiguities : revised.ambiguities
					};
					logSchemaCheck('revise.repair_applied', {
						draftId: draft.id,
						fixed: true
					});
				} else {
					logSchemaCheck('revise.repair_invalid', {
						draftId: draft.id,
						errors: repairedValidation.errors
					});
				}
			} catch (repairErr) {
				logSchemaCheck('revise.repair_failed', {
					draftId: draft.id,
					error: repairErr instanceof Error ? repairErr.message : String(repairErr)
				});
			}
		}

		if (!finalValidation.ok || !finalValidation.value) {
			logSchemaCheck('revise.schema_invalid', { draftId: draft.id, errors: finalValidation.errors });
			return error(422, `Revised schema validation failed: ${finalValidation.errors.join('; ')}`);
		}

		const layoutDetails = getSchemaLayoutLogDetails(finalValidation.value);
		if (layoutDetails) {
			logSchemaCheck('revise.layout_metrics', {
				draftId: draft.id,
				...layoutDetails,
				layoutAutoCorrected: (finalValidation.value as any)?.meta?.layoutAutoCorrected === true,
				layoutCorrections: Array.isArray((finalValidation.value as any)?.meta?.layoutCorrections)
					? (finalValidation.value as any).meta.layoutCorrections
					: []
			});
		}

		const assistantContent = formatSchemaAssistantContent({
			revisionIndex,
			assumptions: finalRevision.assumptions,
			ambiguities: finalRevision.ambiguities,
			language
		});

		const result = await db.$transaction(async (txRaw: any) => {
			const tx = txRaw as any;
			const updatedDraft = await tx.taskDraft.update({
				where: { id: draft.id },
				data: {
					status: 'AWAITING_REVIEW',
					currentSchema: finalValidation.value,
					schemaVersion: finalValidation.version ?? '2.0',
					revisionCount: revisionIndex
				}
			});

			await tx.taskDraftRevision.create({
				data: {
					draftId: draft.id,
					revisionIndex,
					schemaVersion: finalValidation.version ?? '2.0',
					userNotes: notes,
					schema: finalValidation.value,
					assumptions: finalRevision.assumptions,
					ambiguities: finalRevision.ambiguities
				}
			});

			const assistantMessage = await tx.message.create({
				data: {
					chatId: draft.chatId,
					draftId: draft.id,
					role: 'ASSISTANT',
					content: assistantContent,
					schemaData: JSON.stringify(finalValidation.value),
					schemaVersion: finalValidation.version ?? '2.0',
					usedModels: JSON.stringify(finalRevision.usedModels)
				}
			});

			return { updatedDraft, assistantMessage };
		});

		return json({
			draftId: draft.id,
			status: result.updatedDraft.status,
			schemaVersion: finalValidation.version ?? '2.0',
			revisionIndex,
			schema: finalValidation.value,
			assumptions: finalRevision.assumptions,
			ambiguities: finalRevision.ambiguities,
			assistantMessage: {
				id: result.assistantMessage.id,
				role: result.assistantMessage.role,
				content: result.assistantMessage.content,
				schemaData: finalValidation.value,
				usedModels: finalRevision.usedModels,
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
	} finally {
		logSchemaCheck('revise.finished', {
			draftId: params.draftId,
			durationMs: Date.now() - startedAt
		});
	}
};
