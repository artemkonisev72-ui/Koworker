/**
 * pyodide-worker.ts
 * Работает ТОЛЬКО в дочернем потоке (worker_threads).
 * Никогда не вызывается из главного потока напрямую.
 *
 * Протокол сообщений:
 * Входящее: { id: string, code: string }
 * Исходящее: { id: string, ok: true,  stdout: string }
 *           | { id: string, ok: false, error: string }
 */
import { parentPort } from 'worker_threads';
import { loadPyodide, type PyodideInterface } from 'pyodide';

if (!parentPort) {
	throw new Error('pyodide-worker must be run in a worker_thread');
}

// ── Инициализация Pyodide ────────────────────────────────────────────────────
let pyodide: PyodideInterface | null = null;

async function init(): Promise<void> {
	pyodide = await loadPyodide();
	// Устанавливаем sympy и numpy один раз при старте воркера
	await pyodide.loadPackage(['sympy', 'numpy']);
	parentPort!.postMessage({ type: 'ready' });
}

// ── Выполнение задачи ────────────────────────────────────────────────────────
async function runTask(id: string, code: string): Promise<void> {
	if (!pyodide) {
		parentPort!.postMessage({ id, ok: false, error: 'Pyodide not initialized' });
		return;
	}

	// Перехватываем stdout в буфер
	let stdout = '';
	pyodide.setStdout({
		batched: (s: string) => {
			stdout += s + '\n';
		}
	});

	try {
		await pyodide.runPythonAsync(code);
		parentPort!.postMessage({ id, ok: true, stdout: stdout.trim() });
	} catch (err: unknown) {
		const error = err instanceof Error ? err.message : String(err);
		parentPort!.postMessage({ id, ok: false, error });
	} finally {
		// Сбрасываем stdout
		pyodide.setStdout({ batched: () => {} });
	}
}

// ── Обработка входящих сообщений ─────────────────────────────────────────────
parentPort.on('message', (msg: { id: string; code: string }) => {
	runTask(msg.id, msg.code).catch((err) => {
		parentPort!.postMessage({
			id: msg.id,
			ok: false,
			error: String(err)
		});
	});
});

// Стартуем
init().catch((err) => {
	// Критическая ошибка инициализации — сообщаем родителю
	parentPort!.postMessage({ type: 'init_error', error: String(err) });
	process.exit(1);
});
