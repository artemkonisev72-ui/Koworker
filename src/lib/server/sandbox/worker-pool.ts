/**
 * worker-pool.ts
 * Пул воркеров Pyodide. Реализует:
 *   • External Heartbeat (Promise.race + 10s таймаут из главного потока)
 *   • Lifecycle Policy (terminate + пересоздание каждые 10 задач)
 *   • Pre-flight валидация кода (разрешены только math, sympy, numpy, json)
 */
import { Worker } from 'worker_threads';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== 'production';

// In dev: tsx executes the TypeScript worker directly (no compilation needed).
// In prod: the worker is pre-compiled to pyodide-worker.js by `npm run build:worker`.
const WORKER_SCRIPT = isDev
	? path.resolve(__dirname, 'pyodide-worker.ts')
	: path.resolve(__dirname, 'pyodide-worker.js');

const WORKER_OPTIONS = isDev ? { execArgv: ['--import', 'tsx/esm'] } : {};

const TASK_TIMEOUT_MS = 10_000; // 10 секунд на задачу
const MAX_TASKS_PER_WORKER = 10; // Lifecycle Policy
const POOL_SIZE = 2; // Количество параллельных воркеров

// ── Разрешённые модули (Pre-flight) ──────────────────────────────────────────
// Паттерн ловит любой import/from за пределами: math, sympy, numpy, json
const FORBIDDEN_IMPORT_RE = /^(?:import|from)\s+(?!math\b|sympy\b|numpy\b|json\b)(\w+)/m;

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

// ── Одна запись пула ─────────────────────────────────────────────────────────
interface PoolEntry {
	worker: Worker;
	taskCount: number;
	busy: boolean;
	ready: boolean;
	// Ожидающие обещания, индексированные по id задачи
	pending: Map<string, { resolve: (v: ExecutionResult) => void; reject: (e: Error) => void }>;
}

// ── Пул ─────────────────────────────────────────────────────────────────────
class WorkerPool {
	private entries: PoolEntry[] = [];
	private queue: Array<() => void> = []; // Задачи, ждущие свободного воркера

	constructor() {
		for (let i = 0; i < POOL_SIZE; i++) {
			this.entries.push(this.createEntry());
		}
	}

	// ── Создание нового воркера ──────────────────────────────────────────────
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

			// Обычный ответ задачи
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

				// Lifecycle Policy — убиваем и пересоздаём воркер
				if (entry.taskCount >= MAX_TASKS_PER_WORKER) {
					this.recycleEntry(entry);
				} else {
					this.drainQueue();
				}
			}
		});

		worker.on('error', (err) => {
			console.error('[WorkerPool] Worker error:', err);
			// Отклоняем все ожидающие задачи
			for (const [, promise] of entry.pending) {
				promise.reject(new SandboxError(`Worker crashed: ${err.message}`));
			}
			entry.pending.clear();
			this.recycleEntry(entry);
		});

		return entry;
	}

	// ── Lifecycle Policy: убиваем и пересоздаём ──────────────────────────────
	private recycleEntry(entry: PoolEntry): void {
		entry.worker.terminate(); // Жёсткое уничтожение
		const idx = this.entries.indexOf(entry);
		if (idx !== -1) {
			this.entries[idx] = this.createEntry();
		}
	}

	// ── Сброс очереди: даём задачи свободным воркерам ────────────────────────
	private drainQueue(): void {
		const freeEntry = this.entries.find((e) => e.ready && !e.busy);
		if (!freeEntry || this.queue.length === 0) return;
		const next = this.queue.shift()!;
		next();
	}

	// ── Pre-flight проверка кода ─────────────────────────────────────────────
	private validateCode(code: string): void {
		const lines = code.split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			if (FORBIDDEN_IMPORT_RE.test(trimmed)) {
				const match = trimmed.match(FORBIDDEN_IMPORT_RE);
				throw new SandboxError(
					`Запрещённый импорт: "${match?.[1]}". Разрешены только: math, sympy, numpy, json`
				);
			}
		}
		// Дополнительно блокируем опасные builtins
		if (/\b(open|eval|exec|compile|__import__|os\.|sys\.|subprocess)\b/.test(code)) {
			throw new SandboxError('Код содержит запрещённые операции (open/eval/exec/os/sys)');
		}
	}

	// ── Публичный метод выполнения ───────────────────────────────────────────
	execute(code: string): Promise<ExecutionResult> {
		// Pre-flight валидация
		this.validateCode(code);

		return new Promise<ExecutionResult>((resolve, reject) => {
			const runOnEntry = (entry: PoolEntry) => {
				entry.busy = true;
				entry.taskCount++;
				const id = randomUUID();
				entry.pending.set(id, { resolve, reject });

				// ── External Heartbeat: Promise.race с тайм-аутом из главного потока ──
				// Wasm блокирует внутренние таймеры воркера, поэтому таймаут
				// ОБЯЗАТЕЛЬНО запускается в главном потоке здесь.
				const timer = setTimeout(() => {
					entry.pending.delete(id);
					entry.busy = false;

					// Жёсткое уничтожение зависшего процесса
					console.warn(`[WorkerPool] Task ${id} timed out — terminating worker`);
					this.recycleEntry(entry);

					reject(new SandboxError('Превышен лимит времени выполнения (10 сек)'));
				}, TASK_TIMEOUT_MS);

				// Оборачиваем resolve/reject чтобы отменять таймер
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

			const freeEntry = this.entries.find((e) => e.ready && !e.busy);
			if (freeEntry) {
				runOnEntry(freeEntry);
			} else {
				// Ставим в очередь
				this.queue.push(() => {
					const entry = this.entries.find((e) => e.ready && !e.busy);
					if (entry) runOnEntry(entry);
				});
			}
		});
	}
}

// ── Синглтон пула (переиспользуется между запросами) ─────────────────────────
const globalPool = globalThis as unknown as { _workerPool?: WorkerPool };
export const workerPool = globalPool._workerPool ?? new WorkerPool();
if (!globalPool._workerPool) globalPool._workerPool = workerPool;
