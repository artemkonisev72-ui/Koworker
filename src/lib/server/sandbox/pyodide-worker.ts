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

if (!parentPort) {
	throw new Error('pyodide-worker must be run in a worker_thread');
}

let pyodide: PyodideInterface | null = null;
let currentStdout = '';

const EXEC_WRAPPER = `
import builtins as __builtins_mod
import math, sympy, numpy, json

_ALLOWED_IMPORTS = {"math", "sympy", "numpy", "json"}
_REAL_IMPORT = __builtins_mod.__import__

def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in _ALLOWED_IMPORTS:
        raise ImportError(f"Import '{name}' is blocked")
    return _REAL_IMPORT(name, globals, locals, fromlist, level)

_SAFE_BUILTINS = {
    "__import__": _safe_import,
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "pow": pow,
    "print": print,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
    "Exception": Exception,
    "ValueError": ValueError,
    "TypeError": TypeError
}

_globals = {
    "__builtins__": _SAFE_BUILTINS,
    "math": math,
    "sympy": sympy,
    "numpy": numpy,
    "np": numpy,
    "json": json
}

exec(compile(__sandbox_code, "<sandbox>", "exec"), _globals, None)
`;

async function init(): Promise<void> {
	pyodide = await loadPyodide({
		stdout: (s: string) => {
			currentStdout += s + '\n';
		},
		stderr: (s: string) => {
			currentStdout += s + '\n';
		}
	});

	await pyodide.loadPackage(['sympy', 'numpy']);
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
		await pyodide.runPythonAsync(EXEC_WRAPPER);
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
