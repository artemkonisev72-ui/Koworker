import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import {
	resolveClientSandboxRequest
} from '$lib/server/sandbox/client-bridge.js';
import type { SandboxErrorKind, SandboxExecutionResponse } from '$lib/sandbox/shared.js';

function normalizeErrorKind(value: unknown): SandboxErrorKind {
	if (value === 'python_error') return 'python_error';
	if (value === 'timeout') return 'timeout';
	if (value === 'wasm_oom') return 'wasm_oom';
	if (value === 'worker_crash') return 'worker_crash';
	if (value === 'unsupported') return 'unsupported';
	if (value === 'warmup_failed') return 'warmup_failed';
	if (value === 'validation_error') return 'validation_error';
	return 'unknown';
}

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return error(401, 'Нужно войти в аккаунт.');

	let body: {
		requestId?: string;
		ok?: boolean;
		stdout?: string;
		error?: string;
		errorKind?: string;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return error(400, 'Некорректный JSON-запрос.');
	}

	if (!body.requestId || typeof body.requestId !== 'string') {
		return error(400, 'requestId is required');
	}
	if (typeof body.ok !== 'boolean') {
		return error(400, 'ok flag is required');
	}

	let payload: SandboxExecutionResponse;
	if (body.ok) {
		payload = {
			ok: true,
			stdout: typeof body.stdout === 'string' ? body.stdout : ''
		};
	} else {
		payload = {
			ok: false,
			error: typeof body.error === 'string' ? body.error : 'Unknown client sandbox error',
			errorKind: normalizeErrorKind(body.errorKind)
		};
	}

	const accepted = resolveClientSandboxRequest({
		requestId: body.requestId,
		userId: locals.user.id,
		payload
	});

	if (!accepted) {
		return error(404, 'Sandbox request not found or already expired');
	}

	return json({ ok: true });
};
