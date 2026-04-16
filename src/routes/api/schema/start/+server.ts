import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { generateInitialSchema, repairSchemaByIssues } from '$lib/server/ai/gemini.js';
import {
	isModelPreference,
	normalizeModelPreference,
	toForcedModel
} from '$lib/server/ai/model-preference.js';
import { validateSchemaAny } from '$lib/schema/schema-any.js';
import {
	detectPromptLanguage,
	formatSchemaAssistantContent,
	getSchemaLayoutLogDetails,
	loadGeminiHistory,
	logSchemaCheck,
	validateImageData,
	validateUserPrompt,
	type InputImageData
} from '$lib/server/schema/flow.js';

interface StartSchemaBody {
	chatId?: string;
	message?: string;
	imageData?: InputImageData;
	mode?: string;
	modelPreference?: string;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	const db = prisma as any;
	const startedAt = Date.now();

	let body: StartSchemaBody;
	try {
		body = (await request.json()) as StartSchemaBody;
	} catch {
		logSchemaCheck('start.invalid_json', { userId: locals.user.id });
		return error(400, 'Invalid JSON body');
	}

	const chatId = body.chatId;
	const message = body.message ?? '';
	const imageData = body.imageData;
	logSchemaCheck('start.request', {
		userId: locals.user.id,
		chatId,
		mode: body.mode ?? 'schema_check',
		messageLength: message.length,
		hasImage: Boolean(imageData)
	});

	if (!chatId) return error(400, 'chatId is required');
	if (body.mode && body.mode !== 'schema_check') return error(400, 'Unsupported mode');
	if (body.modelPreference !== undefined && !isModelPreference(body.modelPreference)) {
		return error(400, `Unsupported modelPreference: ${String(body.modelPreference)}`);
	}

	const promptError = validateUserPrompt(message);
	if (promptError) {
		logSchemaCheck('start.validation_error', { userId: locals.user.id, chatId, reason: promptError });
		return error(400, promptError);
	}

	const imageError = validateImageData(imageData);
	if (imageError) {
		logSchemaCheck('start.validation_error', { userId: locals.user.id, chatId, reason: imageError });
		return error(400, imageError);
	}

	const chat = await db.chat.findUnique({
		where: { id: chatId },
		select: { id: true, userId: true, modelPreference: true }
	});
	if (!chat) return error(404, 'Chat not found');
	if (chat.userId !== locals.user.id) return error(403, 'Forbidden');
	logSchemaCheck('start.chat_loaded', {
		userId: locals.user.id,
		chatId,
		modelPreference: chat.modelPreference
	});

	const effectiveModelPreference =
		body.modelPreference !== undefined
			? normalizeModelPreference(body.modelPreference)
			: normalizeModelPreference(chat.modelPreference);
	const forcedModel = toForcedModel(effectiveModelPreference);
	logSchemaCheck('start.model_resolved', {
		userId: locals.user.id,
		chatId,
		modelPreference: chat.modelPreference,
		requestModelPreference: body.modelPreference ?? null,
		effectiveModelPreference,
		forcedModel
	});
	const history = await loadGeminiHistory(chatId, 4);

	await db.message.create({
		data: {
			chatId,
			role: 'USER',
			content: message,
			imageData: imageData ? JSON.stringify(imageData) : null
		}
	});

	const draft = await db.taskDraft.create({
		data: {
			chatId,
			userId: locals.user.id,
			mode: 'schema_check',
			status: 'DRAFT',
			schemaVersion: '2.0',
			originalPrompt: message,
			originalImageData: imageData ? JSON.stringify(imageData) : null
		}
	});
	logSchemaCheck('start.draft_created', {
		userId: locals.user.id,
		chatId,
		draftId: draft.id,
		status: draft.status
	});

	try {
		const generated = await generateInitialSchema(history, message, {
			imageData,
			forcedModel,
			fastMode: true
		});
		logSchemaCheck('start.llm_generated', {
			draftId: draft.id,
			model: generated.model,
			tokens: generated.tokens,
			assumptions: generated.assumptions.length,
			ambiguities: generated.ambiguities.length
		});
		let finalGenerated = generated;
		let finalValidation = validateSchemaAny(generated.schemaData);

		if (!finalValidation.ok || !finalValidation.value) {
			const repairIssues = finalValidation.errors.slice(0, 6);
			logSchemaCheck('start.repair_requested', {
				draftId: draft.id,
				reason: 'initial_validation_failed',
				errorCount: finalValidation.errors.length,
				issues: repairIssues
			});
			try {
				const repaired = await repairSchemaByIssues(history, {
					originalPrompt: message,
					currentSchema: generated.schemaData,
					issues: repairIssues,
					forcedModel,
					fastMode: true,
					skipSelfCheck: true
				});
				const repairedValidation = validateSchemaAny(repaired.schemaData);
				if (repairedValidation.ok && repairedValidation.value) {
					finalValidation = repairedValidation;
					finalGenerated = {
						...repaired,
						tokens: generated.tokens + repaired.tokens,
						usedModels: [...generated.usedModels, ...repaired.usedModels],
						assumptions: repaired.assumptions.length > 0 ? repaired.assumptions : generated.assumptions,
						ambiguities: repaired.ambiguities.length > 0 ? repaired.ambiguities : generated.ambiguities
					};
					logSchemaCheck('start.repair_applied', {
						draftId: draft.id,
						fixed: true
					});
				} else {
					logSchemaCheck('start.repair_invalid', {
						draftId: draft.id,
						errors: repairedValidation.errors
					});
				}
			} catch (repairErr) {
				logSchemaCheck('start.repair_failed', {
					draftId: draft.id,
					error: repairErr instanceof Error ? repairErr.message : String(repairErr)
				});
			}
		}

		if (!finalValidation.ok || !finalValidation.value) {
			await db.taskDraft.update({ where: { id: draft.id }, data: { status: 'FAILED' } });
			logSchemaCheck('start.schema_invalid', {
				draftId: draft.id,
				errors: finalValidation.errors
			});
			return error(422, `Generated schema validation failed: ${finalValidation.errors.join('; ')}`);
		}

		const layoutDetails = getSchemaLayoutLogDetails(finalValidation.value);
		if (layoutDetails) {
			const schemaMeta = (finalValidation.value as any)?.meta;
			logSchemaCheck('start.layout_metrics', {
				draftId: draft.id,
				...layoutDetails,
				layoutAutoCorrected: schemaMeta?.layoutAutoCorrected === true,
				layoutCorrections: Array.isArray(schemaMeta?.layoutCorrections)
					? schemaMeta.layoutCorrections
					: []
			});
		}

		const assistantContent = formatSchemaAssistantContent({
			revisionIndex: 0,
			assumptions: finalGenerated.assumptions,
			ambiguities: finalGenerated.ambiguities,
			language: detectPromptLanguage(message)
		});

		const result = await db.$transaction(async (txRaw: any) => {
			const tx = txRaw as any;
			const updatedDraft = await tx.taskDraft.update({
				where: { id: draft.id },
				data: {
					status: 'AWAITING_REVIEW',
					currentSchema: finalValidation.value,
					schemaVersion: finalValidation.version ?? '2.0',
					revisionCount: 0
				}
			});

			await tx.taskDraftRevision.create({
				data: {
					draftId: draft.id,
					revisionIndex: 0,
					schemaVersion: finalValidation.version ?? '2.0',
					schema: finalValidation.value,
					assumptions: finalGenerated.assumptions
				}
			});

			const assistantMessage = await tx.message.create({
				data: {
					chatId,
					draftId: draft.id,
					role: 'ASSISTANT',
					content: assistantContent,
					schemaData: JSON.stringify(finalValidation.value),
					schemaVersion: finalValidation.version ?? '2.0',
					usedModels: JSON.stringify(finalGenerated.usedModels)
				}
			});

			const msgCount = await tx.message.count({ where: { chatId } });
			if (msgCount <= 2) {
				const title = message.slice(0, 60) + (message.length > 60 ? '...' : '');
				await tx.chat.update({ where: { id: chatId }, data: { title } });
			}

			return { updatedDraft, assistantMessage };
		});

		return json({
			draftId: draft.id,
			status: result.updatedDraft.status,
			schemaVersion: finalValidation.version ?? '2.0',
			revisionIndex: result.updatedDraft.revisionCount,
			schema: finalValidation.value,
			assumptions: finalGenerated.assumptions,
			ambiguities: finalGenerated.ambiguities,
			assistantMessage: {
				id: result.assistantMessage.id,
				role: result.assistantMessage.role,
				content: result.assistantMessage.content,
				schemaData: finalValidation.value,
				usedModels: finalGenerated.usedModels,
				draftId: result.assistantMessage.draftId,
				createdAt: result.assistantMessage.createdAt
			}
		});
	} catch (err) {
		await db.taskDraft.update({ where: { id: draft.id }, data: { status: 'FAILED' } }).catch(() => undefined);
		const messageText = err instanceof Error ? err.message : String(err);
		logSchemaCheck('start.failed', {
			draftId: draft.id,
			error: messageText,
			durationMs: Date.now() - startedAt
		});
		return error(500, `Failed to generate schema: ${messageText}`);
	}
	finally {
		logSchemaCheck('start.finished', {
			draftId: draft.id,
			durationMs: Date.now() - startedAt
		});
	}
};

