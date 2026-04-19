export type ChatProcessingKind = 'chat' | 'schema_start' | 'schema_revise' | 'schema_confirm';

export interface ChatProcessingSnapshot {
	chatId: string;
	kind: ChatProcessingKind;
	statusMessage: string | null;
	startedAt: number;
}

interface ChatProcessingEntry extends ChatProcessingSnapshot {
	userId: string;
	token: string;
}

type ChatProcessingStore = {
	activeByUser: Map<string, ChatProcessingEntry>;
};

const globalChatProcessing = globalThis as unknown as {
	_chatProcessingStore?: ChatProcessingStore;
};

function getStore(): ChatProcessingStore {
	if (!globalChatProcessing._chatProcessingStore) {
		globalChatProcessing._chatProcessingStore = {
			activeByUser: new Map<string, ChatProcessingEntry>()
		};
	}
	return globalChatProcessing._chatProcessingStore;
}

function toSnapshot(entry: ChatProcessingEntry): ChatProcessingSnapshot {
	return {
		chatId: entry.chatId,
		kind: entry.kind,
		statusMessage: entry.statusMessage,
		startedAt: entry.startedAt
	};
}

function createToken(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `processing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class ChatProcessingConflictError extends Error {
	active: ChatProcessingSnapshot;

	constructor(active: ChatProcessingSnapshot) {
		super('Another task is already being processed for this user.');
		this.name = 'ChatProcessingConflictError';
		this.active = active;
	}
}

export interface ChatProcessingHandle extends ChatProcessingSnapshot {
	userId: string;
	token: string;
	updateStatus: (statusMessage: string | null) => void;
	release: () => void;
}

export function acquireChatProcessing(params: {
	userId: string;
	chatId: string;
	kind: ChatProcessingKind;
	statusMessage?: string | null;
	startedAt?: number;
}): ChatProcessingHandle {
	const store = getStore();
	const existing = store.activeByUser.get(params.userId);
	if (existing) {
		throw new ChatProcessingConflictError(toSnapshot(existing));
	}

	const entry: ChatProcessingEntry = {
		userId: params.userId,
		chatId: params.chatId,
		kind: params.kind,
		statusMessage: params.statusMessage ?? null,
		startedAt: params.startedAt ?? Date.now(),
		token: createToken()
	};

	store.activeByUser.set(params.userId, entry);

	return {
		userId: entry.userId,
		chatId: entry.chatId,
		kind: entry.kind,
		statusMessage: entry.statusMessage,
		startedAt: entry.startedAt,
		token: entry.token,
		updateStatus(statusMessage: string | null) {
			const current = store.activeByUser.get(entry.userId);
			if (!current || current.token !== entry.token) return;
			current.statusMessage = statusMessage;
		},
		release() {
			const current = store.activeByUser.get(entry.userId);
			if (!current || current.token !== entry.token) return;
			store.activeByUser.delete(entry.userId);
		}
	};
}

export function getChatProcessingForUser(userId: string): ChatProcessingSnapshot | null {
	const entry = getStore().activeByUser.get(userId);
	return entry ? toSnapshot(entry) : null;
}

export function resetChatProcessingStoreForTests(): void {
	getStore().activeByUser.clear();
}
