/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from 'pyodide';
import { SANDBOX_BOOTSTRAP, type SandboxErrorKind } from '$lib/sandbox/shared.js';

const REQUIRED_WHEEL_FILES = [
	'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl',
	'mpmath-1.3.0-py3-none-any.whl',
	'sympy-1.13.3-py3-none-any.whl'
] as const;

const REQUIRED_PACKAGE_IMPORTS = 'import numpy, mpmath, sympy';

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

function normalizeIndexURL(indexURL: string): string {
	return indexURL.endsWith('/') ? indexURL : `${indexURL}/`;
}

function appendWorkerLog(line: string): void {
	currentStdout += `${line}\n`;
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function assertRequiredPackagesLoaded(): Promise<void> {
	if (!pyodide) {
		throw new Error('Pyodide not initialized');
	}
	await pyodide.runPythonAsync(REQUIRED_PACKAGE_IMPORTS);
}

async function installWheelManually(wheelUrl: string, sitePackagesPath: string): Promise<void> {
	if (!pyodide) {
		throw new Error('Pyodide not initialized');
	}

	const response = await fetch(wheelUrl, { cache: 'force-cache' });
	if (!response.ok) {
		throw new Error(`Failed to fetch ${wheelUrl}: HTTP ${response.status}`);
	}

	const buffer = await response.arrayBuffer();
	pyodide.unpackArchive(buffer, 'wheel', { extractDir: sitePackagesPath });
}

async function loadRequiredPackages(indexURL: string): Promise<void> {
	if (!pyodide) {
		throw new Error('Pyodide not initialized');
	}

	const baseURL = normalizeIndexURL(indexURL);
	const wheelUrls = REQUIRED_WHEEL_FILES.map((fileName) => `${baseURL}${fileName}`);

	try {
		await pyodide.loadPackage(wheelUrls, {
			checkIntegrity: false,
			messageCallback: appendWorkerLog,
			errorCallback: appendWorkerLog
		});
		await assertRequiredPackagesLoaded();
		return;
	} catch (error: unknown) {
		appendWorkerLog(
			`Pyodide wheel loadPackage path failed; trying manual wheel unpack: ${formatUnknownError(error)}`
		);
	}

	const sitePackagesPath = pyodide.runPython(`
import sysconfig
sysconfig.get_paths()["purelib"]
`) as string;

	for (const wheelUrl of wheelUrls) {
		await installWheelManually(wheelUrl, sitePackagesPath);
	}

	await assertRequiredPackagesLoaded();
}

async function initPyodide(indexURL: string): Promise<void> {
	if (pyodide && lastIndexURL === indexURL) {
		return;
	}

	const normalizedIndexURL = normalizeIndexURL(indexURL);
	currentStdout = '';
	pyodide = await loadPyodide({
		indexURL: normalizedIndexURL,
		lockFileURL: `${normalizedIndexURL}pyodide-lock.json`,
		packageBaseUrl: normalizedIndexURL,
		stdout: (line: string) => {
			currentStdout += `${line}\n`;
		},
		stderr: (line: string) => {
			currentStdout += `${line}\n`;
		}
	});

	await loadRequiredPackages(normalizedIndexURL);
	await pyodide.runPythonAsync(SANDBOX_BOOTSTRAP);
	lastIndexURL = normalizedIndexURL;
}

async function handleWarm(msg: WarmMessage): Promise<void> {
	const indexURL = normalizeIndexURL(msg.indexURL);
	if (!warmPromise || indexURL !== warmIndexURL) {
		warmIndexURL = indexURL;
		warmPromise = initPyodide(indexURL);
	}

	try {
		await warmPromise;
		postWarmResult(true);
	} catch (error: unknown) {
		warmPromise = null;
		warmIndexURL = '';
		lastIndexURL = '';
		pyodide = null;
		const baseMessage = error instanceof Error ? error.message : String(error);
		const workerLog = currentStdout.trim();
		const message = workerLog ? `${baseMessage}\nWorker log:\n${workerLog}` : baseMessage;
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
