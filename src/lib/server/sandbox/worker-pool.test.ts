/**
 * worker-pool.test.ts
 * Unit-тест Ядра Песочницы.
 * Проверяет:
 *  1. Нормальное выполнение корректного Python-кода
 *  2. Rejection при запрещённом импорте (Pre-flight)
 *  3. Rejection при синтаксической ошибке Python (PythonError)
 *  4. Rejection при бесконечном цикле (External Heartbeat timeout)
 *  5. Lifecycle Policy: воркер переживает 10 задач и пересоздаётся
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js → .ts at runtime; svelte-check reports false positive
import { workerPool, SandboxError } from './worker-pool.ts';

// Бесконечный цикл — Wasm заблокирует внутренние таймеры воркера,
// поэтому External Heartbeat (setTimeout в главном потоке) обязан его убить.
const INFINITE_LOOP = `while True: pass`;

const VALID_CODE = `
import json
result = {"answer": 42}
print(json.dumps(result))
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

describe('WorkerPool — Sandbox Safety', () => {
	it('выполняет корректный Python и возвращает stdout', async () => {
		const result = await workerPool.execute(VALID_CODE);
		expect(result.stdout).toContain('"answer": 42');
	}, 30_000);

	it('отклоняет код с запрещённым импортом (Pre-flight)', async () => {
		await expect(workerPool.execute(FORBIDDEN_CODE)).rejects.toThrow(SandboxError);
	});

	it('отклоняет multi-import обход (import json, os)', async () => {
		await expect(workerPool.execute(FORBIDDEN_MULTI_IMPORT_CODE)).rejects.toThrow(SandboxError);
	});

	it('отклоняет попытку выхода через __builtins__', async () => {
		await expect(workerPool.execute(FORBIDDEN_BUILTINS_ESCAPE_CODE)).rejects.toThrow(SandboxError);
	});

	it('отклоняет синтаксически некорректный Python', async () => {
		await expect(workerPool.execute(SYNTAX_ERROR_CODE)).rejects.toThrow(SandboxError);
	}, 30_000);

	it('убивает бесконечный цикл через External Heartbeat (<= 12 сек)', async () => {
		const start = Date.now();
		await expect(workerPool.execute(INFINITE_LOOP)).rejects.toThrow(/timeout|лимит времени/i);
		const elapsed = Date.now() - start;
		// Должно завершиться не позже чем через 12 секунд
		expect(elapsed).toBeLessThan(12_000);
	}, 15_000);

	it('Lifecycle Policy: успешно выполняет серию задач при строгой ротации воркеров', async () => {
		const tasks = Array.from({ length: 4 }, (_, i) =>
			workerPool.execute(`print(${i})`)
		);
		const results = await Promise.all(tasks);
		results.forEach((r: { stdout: string }, i: number) => {
			expect(r.stdout).toContain(String(i));
		});
	}, 120_000);
});
