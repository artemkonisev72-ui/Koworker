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

const SANDBOX_BOOTSTRAP = `
import builtins as __builtins_mod
import math as __sandbox_math
import sympy as __sandbox_sympy
import numpy as __sandbox_numpy
import json as __sandbox_json

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
    "isinstance": isinstance,
    "Exception": Exception,
    "ValueError": ValueError,
    "TypeError": TypeError
}

class _TraceHelper:
    def __init__(self):
        self._doc = {
            "version": "solution-doc-1.0",
            "locale": "ru",
            "sections": []
        }
        self._current_section = None
        self.section("Solution")

    def _ensure_section(self):
        if self._current_section is None:
            self.section("Solution")
        return self._current_section

    def _format(self, value):
        try:
            if isinstance(value, __sandbox_sympy.Basic):
                return __sandbox_sympy.sstr(value)
        except Exception:
            pass

        if isinstance(value, (list, tuple)):
            return "[" + ", ".join(self._format(item) for item in value) + "]"
        if isinstance(value, dict):
            items = list(value.items())
            preview = items[:8]
            text = ", ".join(f"{k}: {self._format(v)}" for k, v in preview)
            if len(items) > len(preview):
                text += ", ..."
            return "{" + text + "}"

        try:
            return str(value)
        except Exception:
            return "<unprintable>"

    def _add_block(self, kind, payload):
        section = self._ensure_section()
        block = {
            "id": f"b{len(section['blocks']) + 1}",
            "kind": kind
        }
        block.update(payload)
        section["blocks"].append(block)
        return block

    def section(self, title):
        title_text = self._format(title)
        section = {
            "id": f"s{len(self._doc['sections']) + 1}",
            "title": title_text,
            "blocks": []
        }
        self._doc["sections"].append(section)
        self._current_section = section
        return section

    def note(self, text):
        return self._add_block("note", {"text": self._format(text)})

    def define(self, name, expr):
        return self._add_block(
            "definition",
            {
                "title": "Definition",
                "text": "Define notation.",
                "expression": f"{self._format(name)} := {self._format(expr)}"
            }
        )

    def equation(self, lhs, rhs=None):
        if rhs is None and isinstance(lhs, __sandbox_sympy.Equality):
            expression = self._format(lhs)
        elif rhs is None:
            expression = self._format(lhs)
        else:
            expression = f"{self._format(lhs)} = {self._format(rhs)}"
        return self._add_block(
            "equation",
            {
                "title": "Equation",
                "text": "Apply relation.",
                "expression": expression
            }
        )

    def solve(self, target, variable=None, result=None):
        payload = {
            "title": "Solve",
            "text": "Solve for target quantity.",
            "expression": self._format(target)
        }
        if variable is not None:
            payload["text"] = f"Solve for {self._format(variable)}"
        if result is not None:
            payload["value"] = self._format(result)
        return self._add_block("solve", payload)

    def result(self, label, value):
        label_text = self._format(label)
        return self._add_block(
            "result",
            {
                "title": "Answer",
                "text": label_text,
                "value": self._format(value)
            }
        )

    def code(self, code_text):
        return self._add_block(
            "code",
            {
                "title": "Technical details",
                "code": self._format(code_text)
            }
        )

    def export(self):
        return self._doc

def _run_sandbox(__sandbox_code):
    __trace = _TraceHelper()
    _globals = {
        "__builtins__": _SAFE_BUILTINS,
        "math": __sandbox_math,
        "sympy": __sandbox_sympy,
        "numpy": __sandbox_numpy,
        "np": __sandbox_numpy,
        "json": __sandbox_json,
        "trace": __trace
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

