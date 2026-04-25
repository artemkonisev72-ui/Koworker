import { randomUUID } from 'crypto';
import type { SandboxErrorKind, SandboxExecutionResponse } from '$lib/sandbox/shared.js';

interface PendingClientExecution {
	userId: string;
	resolve: (stdout: string) => void;
	reject: (error: Error) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

const globalBridgeState = globalThis as unknown as {
	_clientSandboxPending?: Map<string, PendingClientExecution>;
};

const pendingExecutions = globalBridgeState._clientSandboxPending ?? new Map<string, PendingClientExecution>();
if (!globalBridgeState._clientSandboxPending) {
	globalBridgeState._clientSandboxPending = pendingExecutions;
}

export class ClientSandboxResultError extends Error {
	constructor(
		message: string,
		public readonly kind: SandboxErrorKind
	) {
		super(message);
		this.name = 'ClientSandboxResultError';
	}
}

export function createClientSandboxRequest(params: {
	userId: string;
	timeoutMs: number;
}): {
	requestId: string;
	promise: Promise<{ stdout: string }>;
	cancel: (message?: string) => void;
} {
	const requestId = randomUUID();

	const promise = new Promise<{ stdout: string }>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			pendingExecutions.delete(requestId);
			reject(new ClientSandboxResultError('Client sandbox request timeout', 'timeout'));
		}, params.timeoutMs);

		pendingExecutions.set(requestId, {
			userId: params.userId,
			timeoutId,
			resolve: (stdout) => {
				resolve({ stdout });
			},
			reject
		});
	});

	return {
		requestId,
		promise,
		cancel(message = 'Client sandbox request canceled') {
			const pending = pendingExecutions.get(requestId);
			if (!pending) return;
			pendingExecutions.delete(requestId);
			clearTimeout(pending.timeoutId);
			pending.reject(new ClientSandboxResultError(message, 'worker_crash'));
		}
	};
}

export function resolveClientSandboxRequest(params: {
	requestId: string;
	userId: string;
	payload: SandboxExecutionResponse;
}): boolean {
	const pending = pendingExecutions.get(params.requestId);
	if (!pending) return false;
	if (pending.userId !== params.userId) return false;

	pendingExecutions.delete(params.requestId);
	clearTimeout(pending.timeoutId);

	if (params.payload.ok) {
		pending.resolve(params.payload.stdout);
		return true;
	}

	pending.reject(new ClientSandboxResultError(params.payload.error, params.payload.errorKind));
	return true;
}

export function cancelClientSandboxRequest(requestId: string, message?: string): void {
	const pending = pendingExecutions.get(requestId);
	if (!pending) return;
	pendingExecutions.delete(requestId);
	clearTimeout(pending.timeoutId);
	pending.reject(new ClientSandboxResultError(message ?? 'Client sandbox request canceled', 'worker_crash'));
}
