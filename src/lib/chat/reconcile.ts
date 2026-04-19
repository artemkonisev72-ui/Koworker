export interface ReconcileMessage {
	id: string;
	isOptimistic?: boolean;
	isStreaming?: boolean;
}

export function isTempMessageId(id: string): boolean {
	return id.startsWith('temp-');
}

export function dedupeMessagesById<T extends { id: string }>(messages: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (seen.has(message.id)) continue;
		seen.add(message.id);
		out.push(message);
	}
	return out.reverse();
}

export function reconcileMessageId<T extends ReconcileMessage>(
	messages: T[],
	tempId: string,
	persistedId: string | null | undefined
): T[] {
	if (!persistedId || persistedId === tempId) return messages;

	const nextMessages = messages.map((message) => {
		if (message.id !== tempId) return message;
		return {
			...message,
			id: persistedId,
			isOptimistic: false
		};
	});

	return dedupeMessagesById(nextMessages);
}

export function canDeleteMessage(message: ReconcileMessage): boolean {
	if (message.isStreaming || message.isOptimistic) return false;
	return !isTempMessageId(message.id);
}
