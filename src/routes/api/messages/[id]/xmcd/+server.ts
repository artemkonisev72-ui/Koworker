import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { normalizeSolutionDocument } from '$lib/solution/document.js';
import { presentSolutionDocument } from '$lib/solution/presenter.js';
import { buildXmcdFromSolutionDocument } from '$lib/server/xmcd/export.js';

function makeFilename(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, '0');
	return `coworker-solution-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
		now.getHours()
	)}${pad(now.getMinutes())}${pad(now.getSeconds())}.xmcd`;
}

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	const db = prisma as any;
	const requestContext = { messageId: params.id, userId: locals.user.id };
	console.log('[XMCD] export.request', requestContext);

	const message = await db.message.findUnique({
		where: { id: params.id },
		include: {
			chat: {
				select: { id: true, userId: true, title: true }
			}
		}
	});
	if (!message) {
		console.warn('[XMCD] export.message_not_found', requestContext);
		return error(404, 'Message not found');
	}
	if (message.chat.userId !== locals.user.id) {
		console.warn('[XMCD] export.forbidden', {
			...requestContext,
			chatId: message.chat.id
		});
		return error(403, 'Forbidden');
	}

	let rawSolutionDoc = message.solutionDoc;
	// Defensive: old records may have double-serialized solutionDoc (string instead of object)
	if (typeof rawSolutionDoc === 'string') {
		try {
			rawSolutionDoc = JSON.parse(rawSolutionDoc);
		} catch {
			console.warn('[XMCD] export.solution_doc_string_parse_failed', requestContext);
		}
	}
	const normalizedDoc = normalizeSolutionDocument(rawSolutionDoc);
	if (!normalizedDoc) {
		console.warn('[XMCD] export.solution_doc_missing_or_invalid', {
			...requestContext,
			chatId: message.chat.id,
			rawType: typeof rawSolutionDoc,
			rawVersion: rawSolutionDoc && typeof rawSolutionDoc === 'object' ? (rawSolutionDoc as any).version : undefined
		});
		return error(409, 'Detailed solution is not available for this message');
	}

	const solutionDoc = presentSolutionDocument(normalizedDoc, { source: 'legacy' });
	let xmcd: string;
	try {
		xmcd = buildXmcdFromSolutionDocument(solutionDoc, {
			author: locals.user.name ?? locals.user.email ?? 'Coworker User',
			title: message.chat.title
		});
	} catch (err) {
		console.error('[XMCD] export.build_failed', {
			...requestContext,
			chatId: message.chat.id,
			sections: solutionDoc.sections.length,
			blocks: solutionDoc.sections.reduce((sum, section) => sum + section.blocks.length, 0),
			error: err instanceof Error ? err.message : String(err)
		});
		return error(500, 'Failed to build XMCD export');
	}
	const filename = makeFilename();

	console.log('[XMCD] export.success', {
		...requestContext,
		chatId: message.chat.id,
		sections: solutionDoc.sections.length,
		blocks: solutionDoc.sections.reduce((sum, section) => sum + section.blocks.length, 0)
	});

	return new Response(xmcd, {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'no-store'
		}
	});
};
