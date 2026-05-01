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
	MAX_MESSAGE_LENGTH,
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
import { prepareMessageAttachments } from '$lib/server/attachments.js';
import type { ChatAttachmentInput } from '$lib/chat/attachments.js';

interface StartSchemaBody {
	chatId?: string;
	message?: string;
	imageData?: InputImageData;
	images?: ChatImage[];
	attachments?: ChatAttachmentInput[];
	mode?: string;
	modelPreference?: string;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return error(401, 'Нужно войти в аккаунт.');
	const userId = locals.user.id;
	const db = prisma as any;
	const startedAt = Date.now();

	let body: StartSchemaBody;
	try {
		body = (await request.json()) as StartSchemaBody;
	} catch {
		logSchemaCheck('start.invalid_json', { userId });
		return error(400, 'Некорректный JSON-запрос.');
	}

	const chatId = body.chatId;
	const message = body.message ?? '';
	const images = normalizeRequestImages(body);
	const hasAttachments = Array.isArray(body.attachments) ? body.attachments.length > 0 : Boolean(body.attachments);
	logSchemaCheck('start.request', {
		userId,
		chatId,
		mode: body.mode ?? 'schema_check',
		messageLength: message.length,
		imageCount: images.length,
		attachmentCount: Array.isArray(body.attachments) ? body.attachments.length : hasAttachments ? 1 : 0
	});

	if (!chatId) return error(400, 'Нужен идентификатор чата.');
	if (body.mode && body.mode !== 'schema_check') return error(400, 'Неподдерживаемый режим.');
	if (body.modelPreference !== undefined && !isModelPreference(body.modelPreference)) {
		return error(400, `Неподдерживаемая модель: ${String(body.modelPreference)}`);
	}

	if (!hasAttachments) {
		const promptError = validateUserPrompt(message, images);
		if (promptError) {
			logSchemaCheck('start.validation_error', { userId, chatId, reason: promptError });
			return error(400, promptError);
		}
	}

	const imageError = validateImageData(images);
	if (imageError) {
		logSchemaCheck('start.validation_error', { userId, chatId, reason: imageError });
		return error(400, imageError);
	}

	const chat = await db.chat.findUnique({
		where: { id: chatId },
		select: { id: true, userId: true, modelPreference: true }
	});
	if (!chat) return error(404, 'Чат не найден.');
	if (chat.userId !== userId) return error(403, 'Нет доступа к этому чату.');
	logSchemaCheck('start.chat_loaded', {
		userId,
		chatId,
		modelPreference: chat.modelPreference
	});

	const effectiveModelPreference =
		body.modelPreference !== undefined
			? normalizeModelPreference(body.modelPreference)
			: normalizeModelPreference(chat.modelPreference);
	const forcedModel = toForcedModel(effectiveModelPreference);
	logSchemaCheck('start.model_resolved', {
		userId,
		chatId,
		modelPreference: chat.modelPreference,
		requestModelPreference: body.modelPreference ?? null,
		effectiveModelPreference,
		forcedModel
	});

	let preparedAttachments: Awaited<ReturnType<typeof prepareMessageAttachments>>;
	try {
		preparedAttachments = await prepareMessageAttachments({
			rawAttachments: body.attachments,
			prompt: message,
			existingImageCount: images.length
		});
	} catch (attachmentError) {
		const messageText = attachmentError instanceof Error ? attachmentError.message : String(attachmentError);
		logSchemaCheck('start.validation_error', { userId, chatId, reason: messageText });
		return error(messageText.includes('больш') || messageText.includes('размер') ? 413 : 400, messageText);
	}

	const aiImages = [...images, ...preparedAttachments.renderedImages];
	if (hasAttachments) {
		if (message.length > MAX_MESSAGE_LENGTH) {
			return error(413, `Сообщение слишком длинное. Максимум ${MAX_MESSAGE_LENGTH} символов.`);
		}
		if (!preparedAttachments.augmentedPrompt.trim() && aiImages.length === 0) {
			return error(400, 'Не удалось извлечь содержимое из прикреплённых файлов.');
		}
	} else {
		const promptError = validateUserPrompt(preparedAttachments.augmentedPrompt, aiImages);
		if (promptError) {
			logSchemaCheck('start.validation_error', { userId, chatId, reason: promptError });
			return error(400, promptError);
		}
	}
	const combinedImageError = validateImageData(aiImages, {
		maxImages: null,
		maxTotalBase64Length: null
	});
	if (combinedImageError) {
		logSchemaCheck('start.validation_error', { userId, chatId, reason: combinedImageError });
		return error(combinedImageError.toLowerCase().includes('больш') ? 413 : 400, combinedImageError);
	}

	let processingHandle: ChatProcessingHandle;
	try {
		processingHandle = acquireChatProcessing({
			userId,
			chatId,
			kind: 'schema_start',
			statusMessage: 'Строю первичную схему...'
		});
	} catch (processingError) {
		if (processingError instanceof ChatProcessingConflictError) {
			return error(429, 'Другая задача уже обрабатывается. Дождитесь завершения.');
		}
		throw processingError;
	}

	let userMessage: any;
	let draft: any;

	try {
		const created = await db.$transaction(async (tx: any) => {
			const createdMessage = await tx.message.create({
				data: {
					chatId,
					role: 'USER',
					content: message,
					imageData: serializeChatImages(images)
				}
			});

			if (preparedAttachments.dbRows.length > 0) {
				await tx.messageAttachment.createMany({
					data: preparedAttachments.dbRows.map((attachment) => ({
						...attachment,
						messageId: createdMessage.id
					}))
				});
			}

			const createdDraft = await tx.taskDraft.create({
				data: {
					chatId,
					userId,
					mode: 'schema_check',
					status: 'DRAFT',
					schemaVersion: '2.0',
					originalPrompt: preparedAttachments.augmentedPrompt,
					originalImageData: serializeChatImages(aiImages)
				}
			});

			return { userMessage: createdMessage, draft: createdDraft };
		});
		userMessage = created.userMessage;
		draft = created.draft;
		logSchemaCheck('start.draft_created', {
			userId,
			chatId,
			draftId: draft.id,
			status: draft.status
		});

		const generatedUnderstanding = await generateInitialSchemeUnderstanding([], preparedAttachments.augmentedPrompt, {
			images: aiImages,
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
				const titleSource =
					message.trim() ||
					(preparedAttachments.attachments.length > 0
						? `Задача из документа: ${preparedAttachments.attachments[0].fileName}`
						: '');
				const title = titleFromPromptOrImages(titleSource, aiImages);
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
