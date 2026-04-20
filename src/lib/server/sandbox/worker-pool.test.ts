/**
 * worker-pool.test.ts
 * Sandbox core unit tests:
 * 1) valid Python execution
 * 2) forbidden import pre-flight rejection
 * 3) syntax error rejection
 * 4) infinite loop timeout
 * 5) worker lifecycle rotation smoke
 * 6) trace regression checks for sympy handling
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { workerPool, SandboxError } from './worker-pool.ts';

const INFINITE_LOOP = `while True: pass`;

const VALID_CODE = `
import json
result = {"answer": 42}
print(json.dumps(result))
`;

const TRACE_EQUATION_CODE = `
import json
import sympy

x = sympy.Symbol("x")
eq = sympy.Eq(x + 1, 2)
trace.equation(eq)

print(json.dumps({"solutionDoc": trace.export()}))
`;

const TRACE_FORMAT_CODE = `
import json
import sympy

x = sympy.Symbol("x")
trace.note(x)
trace.result("symbol", x + 1)

print(json.dumps({"solutionDoc": trace.export()}))
`;

const TRACE_DEFINE_VALUE_CODE = `
import json
import sympy

x = sympy.Symbol("x")
trace.define("x_expr", x + 1, x + 1)
trace.define("x_expr_kw", x + 2, value=x + 2, title="Def by keyword")

print(json.dumps({"solutionDoc": trace.export()}))
`;

const FORBIDDEN_CODE = `
import os
os.system("ls")
`;

const FORBIDDEN_MULTI_IMPORT_CODE = `
import json, os
print(json.dumps({"x": 1}))
`;

const FORBIDDEN_BUILTINS_ESCAPE_CODE = `
import json
_x = getattr(__builtins__, 'op' + 'en')
print(json.dumps({"x": 1}))
`;

const SYNTAX_ERROR_CODE = `
def foo(
  print("unclosed")
`;

describe('WorkerPool - Sandbox Safety', () => {
	it('executes valid Python and returns stdout', async () => {
		const result = await workerPool.execute(VALID_CODE);
		expect(result.stdout).toContain('"answer": 42');
	}, 30_000);

	it('supports trace.equation(sympy.Eq(...)) without name-mangling failures', async () => {
		const result = await workerPool.execute(TRACE_EQUATION_CODE);
		expect(result.stdout).toContain('"solutionDoc"');
		expect(result.stdout).toContain('x + 1');
	}, 30_000);

	it('formats sympy.Basic values in trace blocks via sympy.sstr path', async () => {
		const result = await workerPool.execute(TRACE_FORMAT_CODE);
		expect(result.stdout).toContain('"solutionDoc"');
		expect(result.stdout).toContain('x + 1');
	}, 30_000);

	it('accepts trace.define with positional and keyword value arguments', async () => {
		const result = await workerPool.execute(TRACE_DEFINE_VALUE_CODE);
		expect(result.stdout).toContain('"solutionDoc"');
		expect(result.stdout).toContain('x + 1');
		expect(result.stdout).toContain('x + 2');
	}, 30_000);

	it('rejects forbidden import code at pre-flight', async () => {
		await expect(workerPool.execute(FORBIDDEN_CODE)).rejects.toThrow(SandboxError);
	});

	it('rejects multi-import bypass attempt (import json, os)', async () => {
		await expect(workerPool.execute(FORBIDDEN_MULTI_IMPORT_CODE)).rejects.toThrow(SandboxError);
	});

	it('rejects escape attempt via __builtins__ access', async () => {
		await expect(workerPool.execute(FORBIDDEN_BUILTINS_ESCAPE_CODE)).rejects.toThrow(SandboxError);
	});

	it('rejects syntactically invalid Python', async () => {
		await expect(workerPool.execute(SYNTAX_ERROR_CODE)).rejects.toThrow(SandboxError);
	}, 30_000);

	it('kills infinite loop via external heartbeat (<= 32s)', async () => {
		const start = Date.now();
		await expect(workerPool.execute(INFINITE_LOOP)).rejects.toThrow(/timeout|time limit|Execution timeout exceeded/i);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(32_000);
	}, 35_000);

	it('lifecycle policy: executes a small task burst successfully', async () => {
		const tasks = Array.from({ length: 4 }, (_, i) => workerPool.execute(`print(${i})`));
		const results = await Promise.all(tasks);
		results.forEach((result: { stdout: string }, i: number) => {
			expect(result.stdout).toContain(String(i));
		});
	}, 120_000);
});
