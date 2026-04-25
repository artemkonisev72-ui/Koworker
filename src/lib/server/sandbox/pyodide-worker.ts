/**
 * pyodide-worker.ts
 * Must run only inside worker_threads.
 *
 * Incoming:  { id: string, code: string }
 * Outgoing:  { id: string, ok: true, stdout: string }
 *         or { id: string, ok: false, error: string }
 */
import { parentPort } from 'worker_threads';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { SANDBOX_BOOTSTRAP } from '$lib/sandbox/shared.js';

if (!parentPort) {
	throw new Error('pyodide-worker must be run in a worker_thread');
}

let pyodide: PyodideInterface | null = null;
let currentStdout = '';

async function init(): Promise<void> {
	pyodide = await loadPyodide({
		stdout: (s: string) => {
			currentStdout += s + '\n';
		},
		stderr: (s: string) => {
			currentStdout += s + '\n';
		}
	});

	await pyodide.loadPackage(['numpy', 'mpmath', 'sympy']);
	await pyodide.runPythonAsync(SANDBOX_BOOTSTRAP);
	parentPort!.postMessage({ type: 'ready' });
}

async function runTask(id: string, code: string): Promise<void> {
	if (!pyodide) {
		parentPort!.postMessage({ id, ok: false, error: 'Pyodide not initialized' });
		return;
	}

	currentStdout = '';

	try {
		pyodide.globals.set('__sandbox_code', code);
		await pyodide.runPythonAsync('_run_sandbox(__sandbox_code)');
		parentPort!.postMessage({ id, ok: true, stdout: currentStdout.trim() });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		parentPort!.postMessage({ id, ok: false, error: message });
	} finally {
		try {
			pyodide.globals.delete('__sandbox_code');
		} catch {
			// ignore cleanup errors
		}
		currentStdout = '';
	}
}

parentPort.on('message', (msg: { id: string; code: string }) => {
	runTask(msg.id, msg.code).catch((err) => {
		parentPort!.postMessage({
			id: msg.id,
			ok: false,
			error: String(err)
		});
	});
});

init().catch((err) => {
	parentPort!.postMessage({ type: 'init_error', error: String(err) });
	process.exit(1);
});
