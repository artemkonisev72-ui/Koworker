import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import {
	generateInitialSchemeUnderstanding,
	repairIntentByIssues
} from '$lib/server/ai/gemini.js';
import {
	isModelPreference,
	normalizeModelPreference,
	toForcedModel
} from '$lib/server/ai/model-preference.js';
import { validateSchemaAny } from '$lib/schema/schema-any.js';
import { compileSchemeIntent, SchemeIntentCompileError } from '$lib/schema/compiler.js';
import {
	schemeUnderstandingFromIntent,
	schemeUnderstandingToIntent
} from '$lib/schema/understanding.js';
import { buildAdaptiveSchemeDescription } from '$lib/server/schema/description.js';
import {
	acquireChatProcessing,
	ChatProcessingConflictError,
	type ChatProcessingHandle
} from '$lib/server/chat-processing.js';
import {
	detectPromptLanguage,
	formatSchemaAssistantContent,
	getSchemaLayoutLogDetails,
	logSchemaCheck,
	validateImageData,
	validateUserPrompt,
	type InputImageData
} from '$lib/server/schema/flow.js';
import {
	normalizeRequestImages,
	serializeChatImages,
	titleFromPromptOrImages,
	type ChatImage
} from '$lib/chat/images.js';

interface StartSchemaBody {
	chatId?: string;
	message?: string;
	imageData?: InputImageData;
	images?: ChatImage[];
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
	const images = normalizeRequestImages(body);
	logSchemaCheck('start.request', {
		userId: locals.user.id,
		chatId,
		mode: body.mode ?? 'schema_check',
		messageLength: message.length,
		imageCount: images.length
	});

	if (!chatId) return error(400, 'chatId is required');
	if (body.mode && body.mode !== 'schema_check') return error(400, 'Unsupported mode');
	if (body.modelPreference !== undefined && !isModelPreference(body.modelPreference)) {
		return error(400, `Unsupported modelPreference: ${String(body.modelPreference)}`);
	}

	const promptError = validateUserPrompt(message, images);
	if (promptError) {
		logSchemaCheck('start.validation_error', { userId: locals.user.id, chatId, reason: promptError });
		return error(400, promptError);
	}

	const imageError = validateImageData(images);
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

	let processingHandle: ChatProcessingHandle;
	try {
		processingHandle = acquireChatProcessing({
			userId: locals.user.id,
			chatId,
			kind: 'schema_start',
			statusMessage: 'Building initial scheme...'
		});
	} catch (processingError) {
		if (processingError instanceof ChatProcessingConflictError) {
			return error(429, 'Another task is already being processed. Please wait for completion.');
		}
		throw processingError;
	}

	let userMessage: any;
	let draft: any;

	try {
		userMessage = await db.message.create({
			data: {
				chatId,
				role: 'USER',
				content: message,
				imageData: serializeChatImages(images)
			}
		});

		draft = await db.taskDraft.create({
			data: {
				chatId,
				userId: locals.user.id,
				mode: 'schema_check',
				status: 'DRAFT',
				schemaVersion: '2.0',
				originalPrompt: message,
				originalImageData: serializeChatImages(images)
			}
		});
		logSchemaCheck('start.draft_created', {
			userId: locals.user.id,
			chatId,
			draftId: draft.id,
			status: draft.status
		});

		const generatedUnderstanding = await generateInitialSchemeUnderstanding([], message, {
			images,
			forcedModel,
			fastMode: false
		});
		processingHandle.updateStatus('Compiling initial scheme...');
		logSchemaCheck('start.understanding_generated', {
			draftId: draft.id,
			model: generatedUnderstanding.model,
			tokens: generatedUnderstanding.tokens,
			assumptions: generatedUnderstanding.assumptions.length,
			ambiguities: generatedUnderstanding.ambiguities.length
		});

		let finalUnderstanding = generatedUnderstanding.understanding;
		let finalIntent = schemeUnderstandingToIntent(finalUnderstanding);
		let assumptions = [...generatedUnderstanding.assumptions];
		let ambiguities = [...generatedUnderstanding.ambiguities];
		const usedModels = [...generatedUnderstanding.usedModels];
		let compiledSchema: ReturnType<typeof compileSchemeIntent> | null = null;

		try {
			compiledSchema = compileSchemeIntent(finalIntent);
		} catch (compileErr) {
			if (!(compileErr instanceof SchemeIntentCompileError)) throw compileErr;
			const repairIssues = compileErr.issues.slice(0, 6);
			logSchemaCheck('start.intent_repair_requested', {
				draftId: draft.id,
				errorCount: compileErr.issues.length,
				issues: repairIssues
			});
			if (repairIssues.length > 0) {
				try {
					const repaired = await repairIntentByIssues([], {
						originalPrompt: message,
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
					logSchemaCheck('start.intent_repair_applied', {
						draftId: draft.id,
						fixed: true,
						compileWarnings: compiledSchema.warnings.length
					});
				} catch (repairErr) {
					logSchemaCheck('start.intent_repair_failed', {
						draftId: draft.id,
						error: repairErr instanceof Error ? repairErr.message : String(repairErr)
					});
				}
			}
		}

		if (!compiledSchema) {
			await db.taskDraft.update({ where: { id: draft.id }, data: { status: 'FAILED' } });
			return error(422, 'Intent compilation failed');
		}

		const finalValidation = validateSchemaAny(compiledSchema.schemaData);
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

		const language = detectPromptLanguage(message);
		const descriptionResult = await buildAdaptiveSchemeDescription({
			schema: finalValidation.value,
			language,
			understanding: finalUnderstanding,
			assumptions,
			forcedModel,
			fastMode: true
		});
		processingHandle.updateStatus('Saving scheme draft...');
		const schemeDescription = descriptionResult.description;
		if (
			descriptionResult.source === 'llm' &&
			descriptionResult.model &&
			typeof descriptionResult.tokens === 'number'
		) {
			usedModels.push(
				`${descriptionResult.model} (SchemeDescription): ${descriptionResult.tokens.toLocaleString('ru-RU')} tokens`
			);
		}

		const assistantContent = formatSchemaAssistantContent({
			revisionIndex: 0,
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
					revisionCount: 0
				}
			});

			await tx.taskDraftRevision.create({
				data: {
					draftId: draft.id,
					revisionIndex: 0,
					schemaVersion: finalValidation.version ?? '2.0',
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
					chatId,
					draftId: draft.id,
					role: 'ASSISTANT',
					content: assistantContent,
					schemaData: JSON.stringify(finalValidation.value),
					schemaDescription: schemeDescription,
					schemaVersion: finalValidation.version ?? '2.0',
					usedModels: JSON.stringify(usedModels)
				}
			});

			const msgCount = await tx.message.count({ where: { chatId } });
			if (msgCount <= 2) {
				const title = titleFromPromptOrImages(message, images);
				await tx.chat.update({ where: { id: chatId }, data: { title } });
			}

			return { updatedDraft, assistantMessage };
		});

		return json({
			draftId: draft.id,
			userMessageId: userMessage.id,
			status: result.updatedDraft.status,
			schemaVersion: finalValidation.version ?? '2.0',
			revisionIndex: result.updatedDraft.revisionCount,
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
		if (draft?.id) {
			await db.taskDraft.update({ where: { id: draft.id }, data: { status: 'FAILED' } }).catch(() => undefined);
		}
		const messageText = err instanceof Error ? err.message : String(err);
		logSchemaCheck('start.failed', {
			draftId: draft?.id ?? null,
			error: messageText,
			durationMs: Date.now() - startedAt
		});
		return error(500, `Failed to generate schema: ${messageText}`);
	} finally {
		processingHandle.release();
		logSchemaCheck('start.finished', {
			draftId: draft?.id ?? null,
			durationMs: Date.now() - startedAt
		});
	}
};
