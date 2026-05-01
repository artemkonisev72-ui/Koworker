/**
 * +server.ts — SSE endpoint
 * POST /api/chat
 *
 * Клиент отправляет: { chatId: string, message: string }
 * Сервер транслирует Server-Sent Events:
 *   data: {"type":"ping"}
 *   data: {"type":"status","message":"..."}
 *   data: {"type":"result","content":"...","generatedCode":"...","graphData":[...]}
 *   data: {"type":"error","message":"..."}
 *   data: [DONE]
 *
 * PING каждые 5 сек держит соединение открытым через Gateway Timeout.
 */
import type { RequestHandler } from './$types';
import {
	runPipeline,
	type ApprovedFollowupContext,
	type PipelineStatus,
	type SandboxExecutionMeta
} from '$lib/server/ai/pipeline.js';
import {
	isModelPreference,
	normalizeModelPreference,
	toForcedModel
} from '$lib/server/ai/model-preference.js';
import {
	acquireChatProcessing,
	ChatProcessingConflictError,
	type ChatProcessingHandle
} from '$lib/server/chat-processing.js';
import {
	ClientSandboxResultError,
	cancelClientSandboxRequest,
	createClientSandboxRequest
} from '$lib/server/sandbox/client-bridge.js';
import { executeFallbackSandbox } from '$lib/server/sandbox/fallback-executor.js';
import { SandboxError } from '$lib/server/sandbox/worker-pool.js';
import { prisma } from '$lib/server/db.js';
import { json, error } from '@sveltejs/kit';
import {
	hasPromptOrImages,
	normalizeRequestImages,
	parseStoredChatImages,
	serializeChatImages,
	titleFromPromptOrImages,
	validateChatImages,
	type ChatImage
} from '$lib/chat/images.js';
import { prepareMessageAttachments, selectAttachmentFields } from '$lib/server/attachments.js';
import {
	attachmentRenderedImages,
	attachmentsFromStoredRows,
	augmentPromptWithAttachments,
	type ChatAttachmentInput
} from '$lib/chat/attachments.js';

const MAX_MESSAGE_LENGTH = 8_000;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const CLIENT_SANDBOX_TIMEOUT_MS = 20_000;
const CLIENT_SANDBOX_EXECUTION_TIMEOUT_MS = 18_000;

const CLIENT_FALLBACK_ERROR_KINDS = new Set([
	'unsupported',
	'wasm_oom',
	'timeout',
	'worker_crash',
	'warmup_failed'
]);

type RateEntry = {
	windowStart: number;
	requestCount: number;
};

const globalRate = globalThis as unknown as { _chatRateMap?: Map<string, RateEntry> };
const chatRateMap = globalRate._chatRateMap ?? new Map<string, RateEntry>();
if (!globalRate._chatRateMap) globalRate._chatRateMap = chatRateMap;

function parseMaybeJson<T>(value: unknown): T | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === 'string') {
		try {
			return JSON.parse(value) as T;
		} catch {
			return undefined;
		}
	}
	return value as T;
}

type SandboxRequestEvent = {
	type: 'sandbox_request';
	requestId: string;
	attempt: number;
	code: string;
	timeoutMs: number;
};

type OutboundEvent = PipelineStatus | SandboxRequestEvent;

export const POST: RequestHandler = async ({ locals, request }) => {
	console.log('[SSE] POST /api/chat received');
	if (!locals.user) return error(401, 'Нужно войти в аккаунт.');
	
	let body: {
		chatId?: string;
		message?: string;
		imageData?: ChatImage;
		images?: ChatImage[];
		attachments?: ChatAttachmentInput[];
		modelPreference?: string;
	};

	try {
		body = (await request.json()) as typeof body;
		console.log(
			'[SSE] body chatId:',
			body.chatId,
			'| message:',
			body.message?.slice(0, 60),
			'| images:',
			normalizeRequestImages(body).length
		);
	} catch {
		console.error('[SSE] Failed to parse JSON body');
		return error(400, 'Некорректный JSON-запрос.');
	}

	const { chatId } = body;
	const message = body.message ?? '';
	const images = normalizeRequestImages(body);
	const hasAttachments = Array.isArray(body.attachments) ? body.attachments.length > 0 : Boolean(body.attachments);
	if (body.modelPreference !== undefined && !isModelPreference(body.modelPreference)) {
		return error(400, `Неподдерживаемая модель: ${String(body.modelPreference)}`);
	}

	if (!chatId || (!hasPromptOrImages(message, images) && !hasAttachments)) {
		console.error('[SSE] Missing chatId or message/image');
		return error(400, 'Нужен чат и сообщение, изображение или документ.');
	}
	if (message.length > MAX_MESSAGE_LENGTH) {
		return error(413, `Сообщение слишком длинное. Максимум ${MAX_MESSAGE_LENGTH} символов.`);
	}

	const imageError = validateChatImages(images);
	if (imageError) {
		return error(imageError.toLowerCase().includes('больш') ? 413 : 400, imageError);
	}

	// Проверяем существование чата и получаем предпочтения модели
	const chat = await prisma.chat.findUnique({
		where: { id: chatId },
		select: { id: true, userId: true, modelPreference: true }
	});
	if (!chat) {
		console.error('[SSE] Чат не найден:', chatId);
		return error(404, 'Чат не найден.');
	}
	if (chat.userId !== locals.user.id) {
		return error(403, 'Нет доступа к этому чату.');
	}

	const effectiveModelPreference =
		body.modelPreference !== undefined
			? normalizeModelPreference(body.modelPreference)
			: normalizeModelPreference(chat.modelPreference);
	const forcedModel = toForcedModel(effectiveModelPreference);
	console.log('[ModelPreference:API] chat model resolved', {
		chatId,
		userId: locals.user.id,
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
		return error(messageText.includes('больш') || messageText.includes('размер') ? 413 : 400, messageText);
	}

	const aiImages = [...images, ...preparedAttachments.renderedImages];
	const combinedImageError = validateChatImages(aiImages, {
		maxImages: null,
		maxTotalBase64Length: null
	});
	if (combinedImageError) {
		return error(combinedImageError.toLowerCase().includes('больш') ? 413 : 400, combinedImageError);
	}
	if (!hasPromptOrImages(preparedAttachments.augmentedPrompt, aiImages)) {
		return error(400, 'Не удалось извлечь содержимое из прикреплённых файлов.');
	}

	// Извлекаем историю сообщений для контекста (последние 20 сообщений)
	let approvedFollowupContext: ApprovedFollowupContext | null = null;
	const latestSolvedDraft = await (prisma as any).taskDraft.findFirst({
		where: {
			chatId,
			userId: locals.user.id,
			status: 'SOLVED'
		},
		orderBy: { updatedAt: 'desc' },
		select: {
			id: true,
			originalPrompt: true,
			approvedSchema: true,
			approvedSchemeDescription: true,
			solverModel: true,
			revisions: {
				orderBy: { revisionIndex: 'asc' },
				select: { userNotes: true }
			}
		}
	});

	if (latestSolvedDraft?.id && latestSolvedDraft?.approvedSchema && latestSolvedDraft?.originalPrompt) {
		const latestSolvedMessage = await (prisma as any).message.findFirst({
			where: {
				chatId,
				draftId: latestSolvedDraft.id,
				role: 'ASSISTANT'
			},
			orderBy: { createdAt: 'desc' },
			select: {
				content: true,
				exactAnswers: true,
				graphData: true,
				createdAt: true
			}
		});

		if (latestSolvedMessage?.createdAt) {
			const postSolveMessages = await (prisma as any).message.findMany({
				where: {
					chatId,
					createdAt: { gt: latestSolvedMessage.createdAt }
				},
				orderBy: { createdAt: 'asc' },
				take: 20,
				select: {
					role: true,
					content: true
				}
			});

			const recentChatContext = postSolveMessages
				.filter((entry: { role: string; content?: string | null }) => entry.role !== 'SYSTEM')
				.map((entry: { role: string; content?: string | null }) => ({
					role: entry.role === 'ASSISTANT' ? 'ASSISTANT' : 'USER',
					content: (entry.content ?? '').trim()
				}))
				.filter((entry: { content: string }) => entry.content.length > 0);

			const revisionNotes = Array.isArray(latestSolvedDraft.revisions)
				? latestSolvedDraft.revisions
						.map((revision: { userNotes?: string | null }) => revision.userNotes?.trim())
						.filter((note: string | undefined): note is string => Boolean(note))
				: [];

			const approvedSchema = parseMaybeJson(latestSolvedDraft.approvedSchema);
			if (approvedSchema) {
				approvedFollowupContext = {
					draftId: latestSolvedDraft.id,
					originalTask: String(latestSolvedDraft.originalPrompt),
					approvedSchema,
					approvedSchemeDescription:
						typeof latestSolvedDraft.approvedSchemeDescription === 'string'
							? latestSolvedDraft.approvedSchemeDescription
							: '',
					solverModel: parseMaybeJson(latestSolvedDraft.solverModel),
					revisionNotes,
					recentChatContext,
					previousSolved: {
						answerText:
							typeof latestSolvedMessage.content === 'string'
								? latestSolvedMessage.content
								: undefined,
						exactAnswers: parseMaybeJson(latestSolvedMessage.exactAnswers),
						graphData: parseMaybeJson(latestSolvedMessage.graphData)
					}
				} as ApprovedFollowupContext;
			}
		}
	}

	const rawHistory = await (prisma as any).message.findMany({
		where: { chatId },
		orderBy: { createdAt: 'asc' },
		take: 20,
		include: {
			attachments: {
				orderBy: { createdAt: 'asc' },
				select: selectAttachmentFields()
			}
		}
	});

	const history = rawHistory.map((m: any) => {
		const attachments = attachmentsFromStoredRows(m.attachments ?? []);
		return {
			role: m.role as 'USER' | 'ASSISTANT',
			content: augmentPromptWithAttachments(m.content || '', attachments),
			images: [...parseStoredChatImages(m.imageData), ...attachmentRenderedImages(attachments)]
		};
	});

	const now = Date.now();
	const userRate = chatRateMap.get(locals.user.id) ?? {
		windowStart: now,
		requestCount: 0
	};
	if (now - userRate.windowStart >= RATE_WINDOW_MS) {
		userRate.windowStart = now;
		userRate.requestCount = 0;
	}
	if (userRate.requestCount >= MAX_REQUESTS_PER_WINDOW) {
		return error(429, 'Слишком много запросов. Подождите и попробуйте ещё раз.');
	}
	userRate.requestCount += 1;
	chatRateMap.set(locals.user.id, userRate);

	let processingHandle: ChatProcessingHandle;
	try {
		processingHandle = acquireChatProcessing({
			userId: locals.user.id,
			chatId,
			kind: 'chat',
			statusMessage: 'Подготавливаю ответ...'
		});
	} catch (processingError) {
		if (processingError instanceof ChatProcessingConflictError) {
			return error(429, 'Другая задача уже обрабатывается. Дождитесь завершения.');
		}
		throw processingError;
	}

	let persistedUserMessageId: string;

	// Сохраняем сообщение пользователя
	try {
		const userMessage = await (prisma as any).$transaction(async (tx: any) => {
			const created = await tx.message.create({
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
						messageId: created.id
					}))
				});
			}

			return created;
		});
		persistedUserMessageId = userMessage.id;
	} catch (err) {
		processingHandle.release();
		throw err;
	}

	const userId = locals.user.id;

	// ── SSE ReadableStream ────────────────────────────────────────────────────
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			let streamClosed = false;
			let pingInterval: ReturnType<typeof setInterval> | null = null;
			const pendingSandboxRequests = new Set<string>();

			function safeEnqueue(chunk: Uint8Array): boolean {
				if (streamClosed || request.signal.aborted) {
					streamClosed = true;
					return false;
				}

				try {
					controller.enqueue(chunk);
					return true;
				} catch (enqueueError) {
					streamClosed = true;
					if (
						enqueueError instanceof TypeError &&
						enqueueError.message.includes('Controller is already closed')
					) {
						console.warn('[SSE] Skip enqueue because stream is already closed');
						return false;
					}
					console.warn('[SSE] Failed to enqueue SSE chunk:', enqueueError);
					return false;
				}
			}

			function send(event: OutboundEvent) {
				const data = `data: ${JSON.stringify(event)}\n\n`;
				return safeEnqueue(encoder.encode(data));
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
					route: 'chat',
					chatId,
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
						route: 'chat',
						chatId,
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
						route: 'chat',
						chatId,
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
								route: 'chat',
								chatId,
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

			function sendDone() {
				if (streamClosed) return;
				safeEnqueue(encoder.encode('data: [DONE]\n\n'));
				try {
					controller.close();
				} catch (closeError) {
					if (
						!(closeError instanceof TypeError) ||
						!closeError.message.includes('Controller is already closed')
					) {
						console.warn('[SSE] Failed to close stream:', closeError);
					}
				} finally {
					streamClosed = true;
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
						cancelClientSandboxRequest(requestId, 'HTTP request aborted');
					}
					pendingSandboxRequests.clear();
				},
				{ once: true }
			);

			send({ type: 'ack', userMessageId: persistedUserMessageId });

			// PING каждые 5 секунд — держит соединение через балансировщик
			pingInterval = setInterval(() => {
				send({ type: 'ping' });
			}, 5000);

			// Запускаем пайплайн асинхронно
			runPipeline(
				preparedAttachments.augmentedPrompt,
				history,
				async (event) => {
					if (event.type === 'status') {
						processingHandle.updateStatus(event.message);
					}
					if (event.type !== 'result') {
						send(event);
						return;
					}

					// Сохраняем финальный ответ в БД
					if (request.signal.aborted) {
							console.log('[SSE] Request aborted, skipping DB save for result');
							return;
					}
					processingHandle.updateStatus('Сохраняю ответ...');
					try {
						if (event.draftId) {
							await (prisma as any).message
								.update({
									where: { id: persistedUserMessageId },
									data: { draftId: event.draftId }
								})
								.catch(() => undefined);
						}

						const assistantMessage = await (prisma as any).message.create({
								data: {
									chatId,
									draftId: event.draftId ?? undefined,
									role: 'ASSISTANT',
									content: event.content,
									generatedCode: event.generatedCode ?? null,
									executionLogs: event.executionLogs ?? null,
									graphData: event.graphData ? JSON.stringify(event.graphData) : undefined,
									exactAnswers: event.exactAnswers ? JSON.stringify(event.exactAnswers) : undefined,
									schemaData: event.schemaData ? JSON.stringify(event.schemaData) : undefined,
									schemaDescription:
										typeof event.schemaDescription === 'string' ? event.schemaDescription : undefined,
									schemaVersion: event.schemaVersion ?? undefined,
									usedModels: event.usedModels ? JSON.stringify(event.usedModels) : undefined
								}
							});

							// Обновляем заголовок чата если это первое сообщение
						const msgCount = await prisma.message.count({ where: { chatId } });
						if (msgCount <= 2) {
							const titleSource =
								message.trim() ||
								(preparedAttachments.attachments.length > 0
									? `Задача из документа: ${preparedAttachments.attachments[0].fileName}`
									: '');
							const title = titleFromPromptOrImages(titleSource, aiImages);
							await prisma.chat.update({ where: { id: chatId }, data: { title } });
						}

						send({
							...event,
							messageId: assistantMessage.id
						});
					} catch (dbErr) {
						console.error('[SSE] DB save error:', dbErr);
						send(event);
					}
				},
				aiImages,
				forcedModel,
				{
					approvedFollowupContext,
					sandboxExecutor: requestSandboxExecution
				}
			)
				.catch((pipelineErr) => {
					console.error('[SSE] Pipeline error:', pipelineErr);
					processingHandle.updateStatus('Обработка завершилась с ошибкой');
					send({ type: 'error', message: String(pipelineErr) });
				})
				.finally(() => {
					if (pingInterval) {
						clearInterval(pingInterval);
						pingInterval = null;
					}
					processingHandle.release();
					for (const requestId of pendingSandboxRequests) {
						cancelClientSandboxRequest(requestId, 'Pipeline finished');
					}
					pendingSandboxRequests.clear();
					sendDone();
				});
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no' // Отключает буферизацию в nginx
		}
	});
};

// ── GET /api/chat?chatId=xxx — история сообщений ──────────────────────────────
export const GET: RequestHandler = async ({ url, locals }) => {
	const chatId = url.searchParams.get('chatId');
	if (!chatId) return error(400, 'Нужен идентификатор чата.');

	const chat = await prisma.chat.findUnique({
		where: { id: chatId },
		select: { userId: true, isPublic: true }
	});

	if (!chat) return error(404, 'Чат не найден.');

	// Разрешить доступ если чат публичный или если пользователь авторизован и это его чат
	if (!chat.isPublic) {
		if (!locals.user) return error(401, 'Нужно войти в аккаунт.');
		if (chat.userId !== locals.user.id) return error(403, 'Нет доступа к этому чату.');
	}

	const messages = await (prisma as any).message.findMany({
		where: { chatId },
		orderBy: { createdAt: 'asc' },
		select: {
			id: true,
			role: true,
			content: true,
			generatedCode: true,
			graphData: true,
			exactAnswers: true,
			schemaData: true,
			schemaDescription: true,
			schemaVersion: true,
			usedModels: true,
			imageData: true,
			attachments: {
				orderBy: { createdAt: 'asc' },
				select: selectAttachmentFields()
			},
			draftId: true,
			createdAt: true
		}
	});

	return json(
		messages.map((message: any) => ({
			...message,
			attachments: attachmentsFromStoredRows(message.attachments ?? [])
		}))
	);
};
