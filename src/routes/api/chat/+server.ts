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
import { runPipeline, type PipelineStatus } from '$lib/server/ai/pipeline.js';
import { prisma } from '$lib/server/db.js';
import { json, error } from '@sveltejs/kit';

const MAX_MESSAGE_LENGTH = 8_000;
const MAX_IMAGE_BASE64_LENGTH = 2_800_000; // ~2 MB binary payload in base64
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const MAX_CONCURRENT_PIPELINES_PER_USER = 2;

type RateEntry = {
	windowStart: number;
	requestCount: number;
	activePipelines: number;
};

const globalRate = globalThis as unknown as { _chatRateMap?: Map<string, RateEntry> };
const chatRateMap = globalRate._chatRateMap ?? new Map<string, RateEntry>();
if (!globalRate._chatRateMap) globalRate._chatRateMap = chatRateMap;

export const POST: RequestHandler = async ({ locals, request }) => {
	console.log('[SSE] POST /api/chat received');
	if (!locals.user) return error(401, 'Unauthorized');
	
	let body: { chatId?: string; message?: string; imageData?: { base64: string; mimeType: string } };

	try {
		body = (await request.json()) as typeof body;
		console.log(
			'[SSE] body chatId:',
			body.chatId,
			'| message:',
			body.message?.slice(0, 60),
			'| image:',
			!!body.imageData
		);
	} catch {
		console.error('[SSE] Failed to parse JSON body');
		return error(400, 'Invalid JSON body');
	}

	const { chatId, message, imageData } = body;

	if (!chatId || !message?.trim()) {
		console.error('[SSE] Missing chatId or message');
		return error(400, 'chatId and message are required');
	}
	if (message.length > MAX_MESSAGE_LENGTH) {
		return error(413, `message is too large (max ${MAX_MESSAGE_LENGTH} chars)`);
	}

	if (imageData) {
		if (!ALLOWED_IMAGE_MIME_TYPES.has(imageData.mimeType)) {
			return error(400, 'Unsupported image mime type');
		}
		if (typeof imageData.base64 !== 'string' || imageData.base64.length > MAX_IMAGE_BASE64_LENGTH) {
			return error(413, 'image is too large');
		}
	}

	// Проверяем существование чата и получаем предпочтения модели
	const chat = await prisma.chat.findUnique({
		where: { id: chatId },
		select: { id: true, userId: true, modelPreference: true }
	});
	if (!chat) {
		console.error('[SSE] Chat not found:', chatId);
		return error(404, 'Chat not found');
	}
	if (chat.userId !== locals.user.id) {
		return error(403, 'Forbidden');
	}

	const forcedModel = chat.modelPreference === 'auto' ? null : chat.modelPreference;

	// Извлекаем историю сообщений для контекста (последние 20 сообщений)
	const rawHistory = await prisma.message.findMany({
		where: { chatId },
		orderBy: { createdAt: 'asc' },
		take: 20
	});

	const history = rawHistory.map((m) => ({
		role: m.role as 'USER' | 'ASSISTANT',
		content: m.content || '',
		imageData: m.imageData ? JSON.parse(m.imageData) : undefined
	}));

	const now = Date.now();
	const userRate = chatRateMap.get(locals.user.id) ?? {
		windowStart: now,
		requestCount: 0,
		activePipelines: 0
	};
	if (now - userRate.windowStart >= RATE_WINDOW_MS) {
		userRate.windowStart = now;
		userRate.requestCount = 0;
	}
	if (userRate.requestCount >= MAX_REQUESTS_PER_WINDOW) {
		return error(429, 'Too many requests. Please wait and try again.');
	}
	if (userRate.activePipelines >= MAX_CONCURRENT_PIPELINES_PER_USER) {
		return error(429, 'Too many concurrent requests. Please wait for completion.');
	}
	userRate.requestCount += 1;
	userRate.activePipelines += 1;
	chatRateMap.set(locals.user.id, userRate);

	const releasePipelineSlot = () => {
		const entry = chatRateMap.get(locals.user!.id);
		if (!entry) return;
		entry.activePipelines = Math.max(0, entry.activePipelines - 1);
		chatRateMap.set(locals.user!.id, entry);
	};

	// Сохраняем сообщение пользователя
	try {
		await prisma.message.create({
			data: {
				chatId,
				role: 'USER',
				content: message,
				imageData: imageData ? JSON.stringify(imageData) : null
			}
		});
	} catch (err) {
		releasePipelineSlot();
		throw err;
	}

	// ── SSE ReadableStream ────────────────────────────────────────────────────
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			function send(event: PipelineStatus) {
				const data = `data: ${JSON.stringify(event)}\n\n`;
				controller.enqueue(encoder.encode(data));
			}

			function sendDone() {
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				controller.close();
			}

			// PING каждые 5 секунд — держит соединение через балансировщик
			const pingInterval = setInterval(() => {
				send({ type: 'ping' });
			}, 5000);

			// Запускаем пайплайн асинхронно
			runPipeline(
				message,
				history,
				async (event) => {
					send(event);

					// Сохраняем финальный ответ в БД
					if (event.type === 'result') {
						if (request.signal.aborted) {
							console.log('[SSE] Request aborted, skipping DB save for result');
							return;
						}
						try {
							await prisma.message.create({
								data: {
									chatId,
									role: 'ASSISTANT',
									content: event.content,
									generatedCode: event.generatedCode ?? null,
									executionLogs: event.executionLogs ?? null,
									graphData: event.graphData ? JSON.stringify(event.graphData) : undefined,
									usedModels: event.usedModels ? JSON.stringify(event.usedModels) : undefined
								}
							});

							// Обновляем заголовок чата если это первое сообщение
							const msgCount = await prisma.message.count({ where: { chatId } });
							if (msgCount <= 2) {
								const title = message.slice(0, 60) + (message.length > 60 ? '...' : '');
								await prisma.chat.update({ where: { id: chatId }, data: { title } });
							}
						} catch (dbErr) {
							console.error('[SSE] DB save error:', dbErr);
						}
					}
				},
				imageData,
				forcedModel
			)
				.catch((pipelineErr) => {
					console.error('[SSE] Pipeline error:', pipelineErr);
					send({ type: 'error', message: String(pipelineErr) });
				})
				.finally(() => {
					clearInterval(pingInterval);
					releasePipelineSlot();
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
	if (!chatId) return error(400, 'chatId is required');

	const chat = await prisma.chat.findUnique({
		where: { id: chatId },
		select: { userId: true, isPublic: true }
	});

	if (!chat) return error(404, 'Chat not found');

	// Разрешить доступ если чат публичный или если пользователь авторизован и это его чат
	if (!chat.isPublic) {
		if (!locals.user) return error(401, 'Unauthorized');
		if (chat.userId !== locals.user.id) return error(403, 'Forbidden');
	}

	const messages = await prisma.message.findMany({
		where: { chatId },
		orderBy: { createdAt: 'asc' },
		select: {
			id: true,
			role: true,
			content: true,
			generatedCode: true,
			graphData: true,
			usedModels: true,
			imageData: true,
			createdAt: true
		}
	});

	return json(messages);
};
