import http from 'node:http';
import { SandboxError, workerPool } from './worker-pool.js';

const PORT = Number(process.env.SANDBOX_SERVICE_PORT ?? '3001');
const HOST = process.env.SANDBOX_SERVICE_HOST ?? '127.0.0.1';
const AUTH_TOKEN = process.env.SANDBOX_SERVICE_TOKEN ?? '';
const MAX_BODY_BYTES = 256_000;

function sendJson(
	res: http.ServerResponse<http.IncomingMessage>,
	statusCode: number,
	payload: Record<string, unknown>
): void {
	const body = JSON.stringify(payload);
	res.writeHead(statusCode, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body).toString()
	});
	res.end(body);
}

function isAuthorized(req: http.IncomingMessage): boolean {
	if (!AUTH_TOKEN) return true;
	const value = req.headers.authorization;
	if (!value || !value.startsWith('Bearer ')) return false;
	const provided = value.slice('Bearer '.length).trim();
	return provided === AUTH_TOKEN;
}

async function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > MAX_BODY_BYTES) {
			throw new Error('Request payload is too large');
		}
		chunks.push(buffer);
	}

	const raw = Buffer.concat(chunks).toString('utf-8');
	if (!raw) return {};
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		throw new Error('Invalid JSON body');
	}
}

const server = http.createServer(async (req, res) => {
	const method = req.method ?? 'GET';
	const url = req.url ?? '/';

	if (url === '/health' && method === 'GET') {
		sendJson(res, 200, { ok: true, service: 'sandbox', pid: process.pid });
		return;
	}

	if (url === '/execute' && method === 'POST') {
		if (!isAuthorized(req)) {
			sendJson(res, 401, { ok: false, error: 'Unauthorized' });
			return;
		}

		try {
			const payload = await parseJsonBody(req);
			const code = typeof payload.code === 'string' ? payload.code : '';
			if (!code) {
				sendJson(res, 400, { ok: false, error: 'code is required' });
				return;
			}

			const result = await workerPool.execute(code);
			sendJson(res, 200, { ok: true, stdout: result.stdout });
			return;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof SandboxError) {
				sendJson(res, 422, { ok: false, error: message });
				return;
			}
			sendJson(res, 500, { ok: false, error: message });
			return;
		}
	}

	sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, HOST, () => {
	console.log(`[sandbox-service] listening on http://${HOST}:${PORT}`);
});
