import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import {
	repairIntentByIssues,
	reviseIntent,
	reviseSchemeUnderstanding
} from '$lib/server/ai/gemini.js';
import {
	isModelPreference,
	normalizeModelPreference,
	toForcedModel
} from '$lib/server/ai/model-preference.js';
import { validateSchemaAny } from '$lib/schema/schema-any.js';
import { compileSchemeIntent, SchemeIntentCompileError } from '$lib/schema/compiler.js';
import { validateSchemeIntent } from '$lib/schema/intent.js';
import {
	buildSchemeUnderstandingDescription,
	schemeUnderstandingFromIntent,
	schemeUnderstandingToIntent,
	validateSchemeUnderstanding
} from '$lib/schema/understanding.js';
import {
	detectPromptLanguage,
	formatSchemaAssistantContent,
	getSchemaLayoutLogDetails,
	isReviewableStatus,
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

		const storedUnderstandingValidation = draft.currentUnderstanding
			? validateSchemeUnderstanding(draft.currentUnderstanding)
			: null;
		const currentIntentValidation = draft.currentIntent
			? validateSchemeIntent(draft.currentIntent)
			: null;
		const currentUnderstanding =
			storedUnderstandingValidation?.ok && storedUnderstandingValidation.value
				? storedUnderstandingValidation.value
				: currentIntentValidation?.ok && currentIntentValidation.value
					? schemeUnderstandingFromIntent(currentIntentValidation.value)
					: null;

		if (!currentUnderstanding) {
			return error(422, 'Current draft has no valid understanding/intent for revision');
		}

		let revisedUnderstandingResult;
		if (storedUnderstandingValidation?.ok && storedUnderstandingValidation.value) {
			revisedUnderstandingResult = await reviseSchemeUnderstanding([], {
				originalPrompt: draft.originalPrompt,
				currentUnderstanding,
				revisionNotes: notes,
				forcedModel,
				fastMode: false
			});
			logSchemaCheck('revise.understanding_generated', {
				draftId: draft.id,
				model: revisedUnderstandingResult.model,
				tokens: revisedUnderstandingResult.tokens,
				assumptions: revisedUnderstandingResult.assumptions.length,
				ambiguities: revisedUnderstandingResult.ambiguities.length
			});
		} else if (currentIntentValidation?.ok && currentIntentValidation.value) {
			const revisedIntent = await reviseIntent([], {
				originalPrompt: draft.originalPrompt,
				currentIntent: currentIntentValidation.value,
				revisionNotes: notes,
				forcedModel,
				fastMode: false
			});
			revisedUnderstandingResult = {
				understanding: schemeUnderstandingFromIntent(revisedIntent.intent),
				assumptions: revisedIntent.assumptions,
				ambiguities: revisedIntent.ambiguities,
				model: revisedIntent.model,
				tokens: revisedIntent.tokens,
				usedModels: revisedIntent.usedModels
			};
			logSchemaCheck('revise.intent_fallback_applied', {
				draftId: draft.id,
				model: revisedIntent.model,
				tokens: revisedIntent.tokens
			});
		} else {
			return error(422, 'Current draft has no valid baseline for revision');
		}

		let finalUnderstanding = revisedUnderstandingResult.understanding;
		let finalIntent = schemeUnderstandingToIntent(finalUnderstanding);
		let assumptions = [...revisedUnderstandingResult.assumptions];
		let ambiguities = [...revisedUnderstandingResult.ambiguities];
		const usedModels = [...revisedUnderstandingResult.usedModels];
		let compiledSchema: ReturnType<typeof compileSchemeIntent> | null = null;

		try {
			compiledSchema = compileSchemeIntent(finalIntent);
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
					const repaired = await repairIntentByIssues([], {
						originalPrompt: draft.originalPrompt,
						currentIntent: finalIntent,
						issues: repairIssues,
						forcedModel,
						fastMode: true,
						skipSelfCheck: true
					});
					compiledSchema = compileSchemeIntent(repaired.intent);
					finalIntent = repaired.intent;
					finalUnderstanding = schemeUnderstandingFromIntent(repaired.intent);
					assumptions = repaired.assumptions.length > 0 ? repaired.assumptions : assumptions;
					ambiguities = repaired.ambiguities.length > 0 ? repaired.ambiguities : ambiguities;
					usedModels.push(...repaired.usedModels);
					logSchemaCheck('revise.intent_repair_applied', {
						draftId: draft.id,
						fixed: true,
						compileWarnings: compiledSchema.warnings.length
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

		const schemeDescription = buildSchemeUnderstandingDescription(finalUnderstanding, language);
		const assistantContent = formatSchemaAssistantContent({
			revisionIndex,
			assumptions,
			ambiguities,
			language
		});

		const result = await db.$transaction(async (txRaw: any) => {
			const tx = txRaw as any;
			const updatedDraft = await tx.taskDraft.update({
				where: { id: draft.id },
				data: {
					status: 'AWAITING_REVIEW',
					currentUnderstanding: finalUnderstanding,
					currentIntent: finalIntent,
					currentSchema: finalValidation.value,
					currentSchemeDescription: schemeDescription,
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
					understanding: finalUnderstanding,
					intent: finalIntent,
					schema: finalValidation.value,
					schemeDescription,
					assumptions,
					ambiguities
				}
			});

			const assistantMessage = await tx.message.create({
				data: {
					chatId: draft.chatId,
					draftId: draft.id,
					role: 'ASSISTANT',
					content: assistantContent,
					schemaData: JSON.stringify(finalValidation.value),
					schemaDescription: schemeDescription,
					schemaVersion: finalValidation.version ?? '2.0',
					usedModels: JSON.stringify(usedModels)
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
			schemeDescription,
			assumptions,
			ambiguities,
			assistantMessage: {
				id: result.assistantMessage.id,
				role: result.assistantMessage.role,
				content: result.assistantMessage.content,
				schemaData: finalValidation.value,
				schemaDescription: schemeDescription,
				usedModels,
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
