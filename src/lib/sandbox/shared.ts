export const MAX_CODE_LENGTH = 30_000;

export const ALLOWED_IMPORT_ROOTS = ['math', 'sympy', 'numpy', 'json'] as const;
const ALLOWED_IMPORT_SET = new Set<string>(ALLOWED_IMPORT_ROOTS);

const FORBIDDEN_TOKENS_RE =
	/\b(open|eval|exec|compile|__import__|importlib|os\.|sys\.|subprocess|__loader__|__spec__)\b/;
const BUILTINS_ESCAPE_RE =
	/getattr\s*\(\s*__builtins__|__builtins__\s*\[|globals\s*\(\s*\)\s*\[\s*['"]__builtins__['"]|locals\s*\(\s*\)\s*\[\s*['"]__builtins__['"]/;

export const SANDBOX_BOOTSTRAP = `
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
    "Exception": Exception,
    "ValueError": ValueError,
    "TypeError": TypeError
}

def _run_sandbox(__sandbox_code):
    _globals = {
        "__builtins__": _SAFE_BUILTINS,
        "math": __sandbox_math,
        "sympy": __sandbox_sympy,
        "numpy": __sandbox_numpy,
        "np": __sandbox_numpy,
        "json": __sandbox_json
    }
    exec(compile(__sandbox_code, "<sandbox>", "exec"), _globals, None)
`;

export interface SandboxExecutionResult {
	stdout: string;
}

export type SandboxErrorKind =
	| 'python_error'
	| 'timeout'
	| 'wasm_oom'
	| 'worker_crash'
	| 'unsupported'
	| 'warmup_failed'
	| 'validation_error'
	| 'unknown';

export interface SandboxExecutionSuccess {
	ok: true;
	stdout: string;
}

export interface SandboxExecutionFailure {
	ok: false;
	error: string;
	errorKind: SandboxErrorKind;
}

export type SandboxExecutionResponse = SandboxExecutionSuccess | SandboxExecutionFailure;

export class SandboxValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SandboxValidationError';
	}
}

function assertAllowedImport(modulePath: string): void {
	const root = modulePath.split('.')[0].trim();
	if (!root || !ALLOWED_IMPORT_SET.has(root)) {
		throw new SandboxValidationError(
			`Запрещённый импорт "${modulePath}". Разрешено: ${ALLOWED_IMPORT_ROOTS.join(', ')}`
		);
	}
}

function validateImports(code: string): void {
	const importRe = /(?:^|\n)\s*import\s+([^\n#;]+)/g;
	for (const match of code.matchAll(importRe)) {
		const payload = match[1];
		const modules = payload
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => part.split(/\s+as\s+/i)[0]?.trim())
			.filter((part): part is string => Boolean(part));

		for (const moduleName of modules) {
			assertAllowedImport(moduleName);
		}
	}

	const fromRe = /(?:^|\n)\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+/g;
	for (const match of code.matchAll(fromRe)) {
		assertAllowedImport(match[1]);
	}
}

export function validateSandboxCode(code: string): void {
	if (code.length > MAX_CODE_LENGTH) {
		throw new SandboxValidationError(`Code is too large (>${MAX_CODE_LENGTH} chars)`);
	}

	validateImports(code);

	if (FORBIDDEN_TOKENS_RE.test(code) || BUILTINS_ESCAPE_RE.test(code)) {
		throw new SandboxValidationError('Code contains blocked operations');
	}
}
