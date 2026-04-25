/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from 'pyodide';
import { SANDBOX_BOOTSTRAP, type SandboxErrorKind } from '$lib/sandbox/shared.js';

interface WarmMessage {
	type: 'warm';
	indexURL: string;
}

interface ExecuteMessage {
	type: 'execute';
	id: string;
	code: string;
}

type IncomingMessage = WarmMessage | ExecuteMessage;

let pyodide: PyodideInterface | null = null;
let warmPromise: Promise<void> | null = null;
let lastIndexURL = '';
let warmIndexURL = '';
let currentStdout = '';

function postWarmResult(ok: boolean, error?: string, errorKind?: SandboxErrorKind): void {
	self.postMessage({
		type: 'warm_result',
		ok,
		...(error ? { error } : {}),
		...(errorKind ? { errorKind } : {})
	});
}

function postExecResult(
	id: string,
	ok: boolean,
	stdout?: string,
	error?: string,
	errorKind?: SandboxErrorKind
): void {
	self.postMessage({
		type: 'exec_result',
		id,
		ok,
		...(stdout !== undefined ? { stdout } : {}),
		...(error ? { error } : {}),
		...(errorKind ? { errorKind } : {})
	});
}

function classifyError(message: string, stage: 'warm' | 'execute'): SandboxErrorKind {
	const normalized = message.toLowerCase();
	if (
		normalized.includes('out of memory') ||
		normalized.includes('memory access out of bounds') ||
		normalized.includes('wasm memory')
	) {
		return 'wasm_oom';
	}
	if (
		normalized.includes('failed to fetch') ||
		normalized.includes('networkerror') ||
		normalized.includes('importscripts')
	) {
		return stage === 'warm' ? 'warmup_failed' : 'worker_crash';
	}
	if (normalized.includes('pyodide not initialized')) {
		return 'warmup_failed';
	}
	if (normalized.includes('pythonerror') || normalized.includes('traceback')) {
		return 'python_error';
	}
	return stage === 'warm' ? 'warmup_failed' : 'unknown';
}

async function initPyodide(indexURL: string): Promise<void> {
	if (pyodide && lastIndexURL === indexURL) {
		return;
	}

	currentStdout = '';
	pyodide = await loadPyodide({
		indexURL,
		lockFileURL: `${indexURL}pyodide-lock.json`,
		packageBaseUrl: indexURL,
		stdout: (line: string) => {
			currentStdout += `${line}\n`;
		},
		stderr: (line: string) => {
			currentStdout += `${line}\n`;
		}
	});

	await pyodide.loadPackage(['numpy', 'mpmath', 'sympy']);
	await pyodide.runPythonAsync('import numpy, mpmath, sympy');
	await pyodide.runPythonAsync(SANDBOX_BOOTSTRAP);
	lastIndexURL = indexURL;
}

async function handleWarm(msg: WarmMessage): Promise<void> {
	if (!warmPromise || msg.indexURL !== warmIndexURL) {
		warmIndexURL = msg.indexURL;
		warmPromise = initPyodide(msg.indexURL);
	}

	try {
		await warmPromise;
		postWarmResult(true);
	} catch (error: unknown) {
		warmPromise = null;
		warmIndexURL = '';
		lastIndexURL = '';
		pyodide = null;
		const message = error instanceof Error ? error.message : String(error);
		postWarmResult(false, message, classifyError(message, 'warm'));
	}
}

async function handleExecute(msg: ExecuteMessage): Promise<void> {
	try {
		if (warmPromise) {
			await warmPromise;
		}
		if (!pyodide) {
			postExecResult(msg.id, false, undefined, 'Pyodide not initialized', 'warmup_failed');
			return;
		}
		currentStdout = '';
		pyodide.globals.set('__sandbox_code', msg.code);
		await pyodide.runPythonAsync('_run_sandbox(__sandbox_code)');
		postExecResult(msg.id, true, currentStdout.trim());
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		postExecResult(msg.id, false, undefined, message, classifyError(message, 'execute'));
	} finally {
		if (pyodide) {
			try {
				pyodide.globals.delete('__sandbox_code');
			} catch {
				// ignore cleanup errors
			}
		}
		currentStdout = '';
	}
}

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
	const msg = event.data;
	if (!msg || typeof msg !== 'object') return;
	if (msg.type === 'warm') {
		void handleWarm(msg);
		return;
	}
	if (msg.type === 'execute') {
		void handleExecute(msg);
	}
};
