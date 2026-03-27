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

export const POST: RequestHandler = async ({ request }) => {
	let body: { chatId?: string; message?: string };

	try {
		body = (await request.json()) as { chatId?: string; message?: string };
	} catch {
		return error(400, 'Invalid JSON body');
	}

	const { chatId, message } = body;

	if (!chatId || !message?.trim()) {
		return error(400, 'chatId and message are required');
	}

	// Проверяем существование чата
	const chat = await prisma.chat.findUnique({ where: { id: chatId } });
	if (!chat) {
		return error(404, 'Chat not found');
	}

	// Сохраняем сообщение пользователя
	await prisma.message.create({
		data: {
			chatId,
			role: 'USER',
			content: message
		}
	});

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
			runPipeline(message, async (event) => {
				send(event);

				// Сохраняем финальный ответ в БД
				if (event.type === 'result') {
					try {
						await prisma.message.create({
							data: {
								chatId,
								role: 'ASSISTANT',
								content: event.content,
								generatedCode: event.generatedCode ?? null,
								executionLogs: event.executionLogs ?? null,
								graphData: event.graphData ? JSON.stringify(event.graphData) : undefined
							}
						});

						// Обновляем заголовок чата если это первое сообщение
						const msgCount = await prisma.message.count({ where: { chatId } });
						if (msgCount <= 2) {
							// 1 user + 1 assistant
							const title = message.slice(0, 60) + (message.length > 60 ? '...' : '');
							await prisma.chat.update({ where: { id: chatId }, data: { title } });
						}
					} catch (dbErr) {
						console.error('[SSE] DB save error:', dbErr);
					}
				}
			})
				.catch((pipelineErr) => {
					// Ошибка пайплайна — отправляем клиенту вместо тихого зависания
					console.error('[SSE] Pipeline error:', pipelineErr);
					send({ type: 'error', message: String(pipelineErr) });
				})
				.finally(() => {
					clearInterval(pingInterval);
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
export const GET: RequestHandler = async ({ url }) => {
	const chatId = url.searchParams.get('chatId');
	if (!chatId) return error(400, 'chatId is required');

	const messages = await prisma.message.findMany({
		where: { chatId },
		orderBy: { createdAt: 'asc' },
		select: {
			id: true,
			role: true,
			content: true,
			generatedCode: true,
			graphData: true,
			createdAt: true
		}
	});

	return json(messages);
};
