import { SandboxError, workerPool } from './worker-pool.js';

interface SandboxServiceSuccess {
	ok: true;
	stdout: string;
}

interface SandboxServiceFailure {
	ok: false;
	error: string;
}

type SandboxServiceResponse = SandboxServiceSuccess | SandboxServiceFailure;

const SANDBOX_SERVICE_TIMEOUT_MS = Number(process.env.SANDBOX_SERVICE_TIMEOUT_MS ?? 35_000);
const STRICT_SERVICE_ONLY = process.env.SANDBOX_STRICT_SERVICE === 'true';

async function executeViaSandboxService(code: string): Promise<{ stdout: string }> {
	const serviceUrl = process.env.SANDBOX_SERVICE_URL;
	if (!serviceUrl) {
		throw new SandboxError('Sandbox service URL is not configured');
	}

	const token = process.env.SANDBOX_SERVICE_TOKEN;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, SANDBOX_SERVICE_TIMEOUT_MS);

	try {
		const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/execute`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {})
			},
			body: JSON.stringify({ code }),
			signal: controller.signal
		});

		if (!response.ok) {
			const details = await response.text().catch(() => '');
			throw new SandboxError(`Sandbox service error (${response.status}): ${details || 'Unknown error'}`);
		}

		const payload = (await response.json()) as SandboxServiceResponse;
		if (!payload.ok) {
			throw new SandboxError(payload.error || 'Sandbox service execution failed');
		}
		return { stdout: payload.stdout ?? '' };
	} catch (error: unknown) {
		if (error instanceof SandboxError) throw error;
		if (error instanceof Error && error.name === 'AbortError') {
			throw new SandboxError('Sandbox service request timeout');
		}
		throw new SandboxError(error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function executeFallbackSandbox(code: string): Promise<{ stdout: string }> {
	const hasRemoteService = Boolean(process.env.SANDBOX_SERVICE_URL);

	if (hasRemoteService) {
		try {
			const result = await executeViaSandboxService(code);
			console.info('[SandboxExecution] source=server-service', {
				codeLength: code.length
			});
			return result;
		} catch (error) {
			if (STRICT_SERVICE_ONLY) throw error;
			console.warn('[SandboxFallback] Remote sandbox unavailable, using in-process fallback', error);
		}
	}

	const result = await workerPool.execute(code);
	console.info('[SandboxExecution] source=server-in-process', {
		codeLength: code.length,
		reason: hasRemoteService ? 'remote_unavailable' : 'service_not_configured'
	});
	return result;
}
