/**
 * worker-pool.ts
 * Pyodide worker pool with:
 * - main-thread timeout watchdog
 * - strict worker lifecycle isolation
 * - pre-flight code validation
 */
import { Worker } from 'worker_threads';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'node:fs';
import { SandboxValidationError, validateSandboxCode } from '$lib/sandbox/shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let jsWorkerPath = path.resolve(__dirname, 'pyodide-worker.js');
if (!fs.existsSync(jsWorkerPath)) {
	jsWorkerPath = path.resolve(process.cwd(), 'src/lib/server/sandbox/pyodide-worker.js');
}

let tsWorkerPath = path.resolve(__dirname, 'pyodide-worker.ts');
if (!fs.existsSync(tsWorkerPath)) {
	tsWorkerPath = path.resolve(process.cwd(), 'src/lib/server/sandbox/pyodide-worker.ts');
}

const WORKER_SCRIPT = fs.existsSync(jsWorkerPath) ? jsWorkerPath : tsWorkerPath;
const WORKER_OPTIONS = WORKER_SCRIPT.endsWith('.ts') ? { execArgv: ['--import', 'tsx/esm'] } : {};

const TASK_TIMEOUT_MS = 30_000;
const MAX_TASKS_PER_WORKER = 8; // amortize heavy pyodide startup on weak servers
const POOL_SIZE = 1; // lower memory/CPU pressure for weak servers
const MAX_QUEUE_SIZE = 30;

export interface ExecutionResult {
	stdout: string;
}

export class SandboxError extends Error {
	constructor(
		message: string,
		public readonly traceback?: string
	) {
		super(message);
		this.name = 'SandboxError';
	}
}

interface PoolEntry {
	worker: Worker;
	taskCount: number;
	busy: boolean;
	ready: boolean;
	pending: Map<string, { resolve: (v: ExecutionResult) => void; reject: (e: Error) => void }>;
}

class WorkerPool {
	private entries: PoolEntry[] = [];
	private queue: Array<() => void> = [];

	constructor() {
		for (let i = 0; i < POOL_SIZE; i++) {
			this.entries.push(this.createEntry());
		}
	}

	private createEntry(): PoolEntry {
		const worker = new Worker(WORKER_SCRIPT, WORKER_OPTIONS);
		const entry: PoolEntry = {
			worker,
			taskCount: 0,
			busy: false,
			ready: false,
			pending: new Map()
		};

		worker.on('message', (msg: { type?: string; id?: string; ok?: boolean; stdout?: string; error?: string }) => {
			if (msg.type === 'ready') {
				entry.ready = true;
				this.drainQueue();
				return;
			}
			if (msg.type === 'init_error') {
				console.error('[WorkerPool] Init error:', msg.error);
				return;
			}

			if (msg.id) {
				const promise = entry.pending.get(msg.id);
				if (!promise) return;

				entry.pending.delete(msg.id);
				entry.busy = false;

				if (msg.ok) {
					promise.resolve({ stdout: msg.stdout ?? '' });
				} else {
					promise.reject(new SandboxError(msg.error ?? 'Unknown error'));
				}

				if (entry.taskCount >= MAX_TASKS_PER_WORKER) {
					this.recycleEntry(entry);
				} else {
					this.drainQueue();
				}
			}
		});

		worker.on('error', (err) => {
			console.error('[WorkerPool] Worker error:', err);

			for (const [, promise] of entry.pending) {
				promise.reject(new SandboxError(`Worker crashed: ${err.message}`));
			}
			entry.pending.clear();

			setTimeout(() => {
				this.recycleEntry(entry);
			}, 1000);
		});

		return entry;
	}

	private recycleEntry(entry: PoolEntry): void {
		entry.worker.terminate();
		const idx = this.entries.indexOf(entry);
		if (idx !== -1) {
			this.entries[idx] = this.createEntry();
		}
	}

	private drainQueue(): void {
		const freeEntry = this.entries.find((e) => e.ready && !e.busy);
		if (!freeEntry || this.queue.length === 0) return;
		const next = this.queue.shift();
		if (next) next();
	}

	execute(code: string): Promise<ExecutionResult> {
		try {
			validateSandboxCode(code);
		} catch (err) {
			if (err instanceof SandboxValidationError) {
				return Promise.reject(new SandboxError(err.message));
			}
			return Promise.reject(err);
		}

		const freeEntry = this.entries.find((e) => e.ready && !e.busy);
		if (!freeEntry && this.queue.length >= MAX_QUEUE_SIZE) {
			return Promise.reject(
				new SandboxError('Sandbox queue is full. Please retry in a few seconds.')
			);
		}

		return new Promise<ExecutionResult>((resolve, reject) => {
			const runOnEntry = (entry: PoolEntry) => {
				entry.busy = true;
				entry.taskCount++;

				const id = randomUUID();
				entry.pending.set(id, { resolve, reject });

				const timer = setTimeout(() => {
					entry.pending.delete(id);
					entry.busy = false;
					console.warn(`[WorkerPool] Task ${id} timed out, terminating worker`);
					this.recycleEntry(entry);
					reject(new SandboxError('Execution timeout exceeded (30 seconds)'));
				}, TASK_TIMEOUT_MS);

				const originalResolve = entry.pending.get(id)!.resolve;
				const originalReject = entry.pending.get(id)!.reject;
				entry.pending.set(id, {
					resolve: (v) => {
						clearTimeout(timer);
						originalResolve(v);
					},
					reject: (e) => {
						clearTimeout(timer);
						originalReject(e);
					}
				});

				entry.worker.postMessage({ id, code });
			};

			if (freeEntry) {
				runOnEntry(freeEntry);
			} else {
				this.queue.push(() => {
					const entry = this.entries.find((e) => e.ready && !e.busy);
					if (entry) runOnEntry(entry);
				});
			}
		});
	}
}

const globalPool = globalThis as unknown as { _workerPool?: WorkerPool };
export const workerPool = globalPool._workerPool ?? new WorkerPool();
if (!globalPool._workerPool) globalPool._workerPool = workerPool;
