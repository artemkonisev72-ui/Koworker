import { prisma } from '$lib/server/db.js';
import type { GraphData } from '$lib/graphs/types.js';
import { parseStoredChatImages, type ChatImage } from '$lib/chat/images.js';
import { error } from '@sveltejs/kit';

interface ExportMessageRecord {
	id: string;
	role: 'USER' | 'ASSISTANT' | 'SYSTEM';
	content: string;
	graphData: unknown;
	exactAnswers: unknown;
	schemaData: unknown;
	schemaDescription: string | null;
	schemaVersion: string | null;
	usedModels: unknown;
	createdAt: Date | string | null;
	chat: {
		id: string;
		title: string;
		isPublic: boolean;
		userId: string;
	};
}

interface ExportLoaderDb {
	message: {
		findUnique(args: unknown): Promise<ExportMessageRecord | null>;
		findMany(args: unknown): Promise<Array<{ imageData: unknown }>>;
	};
}

export interface ExportPagePayload {
	chat: {
		id: string;
		title: string;
		isPublic: boolean;
	};
	userImages: ChatImage[];
	message: {
		id: string;
		role: 'USER' | 'ASSISTANT' | 'SYSTEM';
		content: string;
		graphData: GraphData[] | string | null;
		exactAnswers: unknown;
		schemaData: unknown;
		schemaDescription: string | null;
		schemaVersion: string | null;
		usedModels: string[] | string | null;
		createdAt?: string;
	};
}

function parseMaybeJson(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function parseChatImagesFromUnknown(value: unknown): ChatImage[] {
	if (typeof value === 'string' || value === null || value === undefined) {
		return parseStoredChatImages(value);
	}
	try {
		return parseStoredChatImages(JSON.stringify(value));
	} catch {
		return [];
	}
}

function normalizeCreatedAt(value: Date | string | null): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString();
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString();
}

function normalizeGraphData(value: unknown): GraphData[] | string | null {
	const parsed = parseMaybeJson(value);
	if (Array.isArray(parsed)) return parsed as GraphData[];
	if (typeof parsed === 'string') return parsed;
	return null;
}

function normalizeUsedModels(value: unknown): string[] | string | null {
	const parsed = parseMaybeJson(value);
	if (typeof parsed === 'string') return parsed;
	if (Array.isArray(parsed)) {
		return parsed.filter((entry): entry is string => typeof entry === 'string');
	}
	return null;
}

export async function loadExportMessageForViewer(params: {
	messageId: string;
	viewerUserId: string | null | undefined;
	db?: ExportLoaderDb;
}): Promise<ExportPagePayload> {
	const messageId = params.messageId.trim();
	if (!messageId) {
		throw error(400, 'message id is required');
	}

	const db = (params.db ?? (prisma as unknown as ExportLoaderDb)) as ExportLoaderDb;
	const message = await db.message.findUnique({
		where: { id: messageId },
		select: {
			id: true,
			role: true,
			content: true,
			graphData: true,
			exactAnswers: true,
			schemaData: true,
			schemaDescription: true,
			schemaVersion: true,
			usedModels: true,
			createdAt: true,
			chat: {
				select: {
					id: true,
					title: true,
					isPublic: true,
					userId: true
				}
			}
		}
	});

	if (!message) {
		throw error(404, 'Message not found');
	}

	if (!message.chat.isPublic) {
		if (!params.viewerUserId) {
			throw error(401, 'Unauthorized');
		}
		if (message.chat.userId !== params.viewerUserId) {
			throw error(403, 'Forbidden');
		}
	}

	const userImageRows = await db.message.findMany({
		where: {
			chatId: message.chat.id,
			role: 'USER'
		},
		orderBy: {
			createdAt: 'asc'
		},
		select: {
			imageData: true
		}
	});
	const userImages = userImageRows.flatMap((row) => parseChatImagesFromUnknown(row.imageData));

	return {
		chat: {
			id: message.chat.id,
			title: message.chat.title,
			isPublic: message.chat.isPublic
		},
		userImages,
		message: {
			id: message.id,
			role: message.role,
			content: message.content ?? '',
			graphData: normalizeGraphData(message.graphData),
			exactAnswers: parseMaybeJson(message.exactAnswers),
			schemaData: parseMaybeJson(message.schemaData),
			schemaDescription:
				typeof message.schemaDescription === 'string' ? message.schemaDescription : null,
			schemaVersion: typeof message.schemaVersion === 'string' ? message.schemaVersion : null,
			usedModels: normalizeUsedModels(message.usedModels),
			createdAt: normalizeCreatedAt(message.createdAt) ?? undefined
		}
	};
}
