import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { generateInitialSchema } from '$lib/server/ai/gemini.js';
import { validateSchemaAny } from '$lib/schema/schema-any.js';
import {
	detectPromptLanguage,
	formatSchemaAssistantContent,
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

	const forcedModel = chat.modelPreference === 'auto' ? null : chat.modelPreference;
	const history = await loadGeminiHistory(chatId);

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
		const generated = await generateInitialSchema(history, message, { imageData, forcedModel });
		logSchemaCheck('start.llm_generated', {
			draftId: draft.id,
			model: generated.model,
			tokens: generated.tokens,
			assumptions: generated.assumptions.length,
			ambiguities: generated.ambiguities.length
		});
		const validation = validateSchemaAny(generated.schemaData);
		if (!validation.ok || !validation.value) {
			await db.taskDraft.update({ where: { id: draft.id }, data: { status: 'FAILED' } });
			logSchemaCheck('start.schema_invalid', {
				draftId: draft.id,
				errors: validation.errors
			});
			return error(422, `Generated schema validation failed: ${validation.errors.join('; ')}`);
		}

		const assistantContent = formatSchemaAssistantContent({
			revisionIndex: 0,
			assumptions: generated.assumptions,
			ambiguities: generated.ambiguities,
			language: detectPromptLanguage(message)
		});

		const result = await db.$transaction(async (txRaw: any) => {
			const tx = txRaw as any;
			const updatedDraft = await tx.taskDraft.update({
				where: { id: draft.id },
				data: {
					status: 'AWAITING_REVIEW',
					currentSchema: validation.value,
					schemaVersion: validation.version ?? '2.0',
					revisionCount: 0
				}
			});

			await tx.taskDraftRevision.create({
				data: {
					draftId: draft.id,
					revisionIndex: 0,
					schemaVersion: validation.version ?? '2.0',
					schema: validation.value,
					assumptions: generated.assumptions
				}
			});

			const assistantMessage = await tx.message.create({
				data: {
					chatId,
					draftId: draft.id,
					role: 'ASSISTANT',
					content: assistantContent,
					schemaData: JSON.stringify(validation.value),
					schemaVersion: validation.version ?? '2.0',
					usedModels: JSON.stringify(generated.usedModels)
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
			schemaVersion: validation.version ?? '2.0',
			revisionIndex: result.updatedDraft.revisionCount,
			schema: validation.value,
			assumptions: generated.assumptions,
			ambiguities: generated.ambiguities,
			assistantMessage: {
				id: result.assistantMessage.id,
				role: result.assistantMessage.role,
				content: result.assistantMessage.content,
				schemaData: validation.value,
				usedModels: generated.usedModels,
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

