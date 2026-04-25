import {
	type SandboxErrorKind,
	type SandboxExecutionResult,
	SandboxValidationError,
	validateSandboxCode
} from '$lib/sandbox/shared.js';

const TASK_TIMEOUT_MS = 30_000;
const MAX_TASKS_PER_WORKER = 8;
const DEFAULT_INDEX_URL = '/pyodide/v0.29.3/';

interface PendingTask {
	resolve: (value: SandboxExecutionResult) => void;
	reject: (error: ClientSandboxError) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

interface WarmDeferred {
	resolve: () => void;
	reject: (error: ClientSandboxError) => void;
}

interface ExecuteOptions {
	timeoutMs?: number;
}

export class ClientSandboxError extends Error {
	constructor(
		message: string,
		public readonly kind: SandboxErrorKind
	) {
		super(message);
		this.name = 'ClientSandboxError';
	}
}

function makeTaskId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function shouldRecycleOnError(kind: SandboxErrorKind): boolean {
	return kind === 'worker_crash' || kind === 'wasm_oom' || kind === 'warmup_failed' || kind === 'timeout';
}

export class ClientSandboxManager {
	private worker: Worker | null = null;
	private pendingTasks = new Map<string, PendingTask>();
	private warmPromise: Promise<void> | null = null;
	private warmDeferred: WarmDeferred | null = null;
	private warmReady = false;
	private completedTasks = 0;

	constructor(private readonly indexURL = DEFAULT_INDEX_URL) {}

	private ensureWorker(): Worker {
		if (typeof window === 'undefined' || typeof Worker === 'undefined') {
			throw new ClientSandboxError('Web Worker is not available on this device.', 'unsupported');
		}

		if (this.worker) return this.worker;

		const worker = new Worker(new URL('./pyodide.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
			if (worker !== this.worker) return;
			this.onWorkerMessage(event.data);
		};
		worker.onerror = (event: ErrorEvent) => {
			if (worker !== this.worker) return;
			const message = event.message || 'Client sandbox worker crashed';
			this.failAllPending(message, 'worker_crash');
			this.recycleWorker();
		};
		this.worker = worker;
		this.completedTasks = 0;
		return worker;
	}

	private onWorkerMessage(payload: Record<string, unknown>): void {
		if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return;

		if (payload.type === 'warm_result') {
			const deferred = this.warmDeferred;
			if (!deferred) return;
			this.warmDeferred = null;
			this.warmPromise = null;
			if (payload.ok === true) {
				this.warmReady = true;
				deferred.resolve();
				return;
			}
			this.warmReady = false;
			const errorKind = (payload.errorKind as SandboxErrorKind | undefined) ?? 'warmup_failed';
			const message =
				typeof payload.error === 'string' ? payload.error : 'Failed to initialize client sandbox';
			deferred.reject(new ClientSandboxError(message, errorKind));
			if (shouldRecycleOnError(errorKind)) {
				this.recycleWorker();
			}
			return;
		}

		if (payload.type !== 'exec_result' || typeof payload.id !== 'string') return;

		const pending = this.pendingTasks.get(payload.id);
		if (!pending) return;
		this.pendingTasks.delete(payload.id);
		clearTimeout(pending.timeoutId);

		if (payload.ok === true) {
			pending.resolve({ stdout: typeof payload.stdout === 'string' ? payload.stdout : '' });
			this.completedTasks += 1;
			if (this.completedTasks >= MAX_TASKS_PER_WORKER) {
				this.recycleWorker();
			}
			return;
		}

		const errorKind = (payload.errorKind as SandboxErrorKind | undefined) ?? 'unknown';
		const message = typeof payload.error === 'string' ? payload.error : 'Client sandbox execution failed';
		pending.reject(new ClientSandboxError(message, errorKind));
		if (shouldRecycleOnError(errorKind)) {
			this.recycleWorker();
		}
	}

	private failAllPending(message: string, kind: SandboxErrorKind): void {
		if (this.warmDeferred) {
			this.warmDeferred.reject(new ClientSandboxError(message, kind));
			this.warmDeferred = null;
			this.warmPromise = null;
			this.warmReady = false;
		}

		for (const [id, pending] of this.pendingTasks.entries()) {
			this.pendingTasks.delete(id);
			clearTimeout(pending.timeoutId);
			pending.reject(new ClientSandboxError(message, kind));
		}
	}

	private recycleWorker(): void {
		if (this.worker) {
			this.worker.terminate();
		}
		this.worker = null;
		this.completedTasks = 0;
		this.warmPromise = null;
		this.warmDeferred = null;
		this.warmReady = false;
		for (const [id, pending] of this.pendingTasks.entries()) {
			this.pendingTasks.delete(id);
			clearTimeout(pending.timeoutId);
			pending.reject(new ClientSandboxError('Client sandbox worker was recycled', 'worker_crash'));
		}
	}

	async warm(): Promise<void> {
		const worker = this.ensureWorker();
		if (this.warmReady) return;
		if (this.warmPromise) {
			await this.warmPromise;
			return;
		}

		this.warmPromise = new Promise<void>((resolve, reject) => {
			this.warmDeferred = { resolve, reject };
			worker.postMessage({
				type: 'warm',
				indexURL: this.indexURL
			});
		});

		await this.warmPromise;
	}

	async execute(code: string, options: ExecuteOptions = {}): Promise<SandboxExecutionResult> {
		try {
			validateSandboxCode(code);
		} catch (error: unknown) {
			if (error instanceof SandboxValidationError) {
				throw new ClientSandboxError(error.message, 'validation_error');
			}
			throw error;
		}

		await this.warm();
		const worker = this.worker;
		if (!worker) {
			throw new ClientSandboxError('Client sandbox worker is unavailable', 'worker_crash');
		}

		const id = makeTaskId();
		const timeoutMs =
			typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
				? Math.max(1_000, Math.min(options.timeoutMs, TASK_TIMEOUT_MS))
				: TASK_TIMEOUT_MS;

		return new Promise<SandboxExecutionResult>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.pendingTasks.delete(id);
				reject(new ClientSandboxError('Client sandbox execution timeout', 'timeout'));
				this.recycleWorker();
			}, timeoutMs);

			this.pendingTasks.set(id, { resolve, reject, timeoutId });
			worker.postMessage({
				type: 'execute',
				id,
				code
			});
		});
	}

	dispose(): void {
		this.recycleWorker();
	}
}

export const clientSandbox = new ClientSandboxManager();
