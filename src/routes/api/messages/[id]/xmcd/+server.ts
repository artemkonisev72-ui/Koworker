import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { prisma } from '$lib/server/db.js';
import { normalizeSolutionDocument } from '$lib/solution/document.js';
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

	const message = await db.message.findUnique({
		where: { id: params.id },
		include: {
			chat: {
				select: { id: true, userId: true, title: true }
			}
		}
	});
	if (!message) return error(404, 'Message not found');
	if (message.chat.userId !== locals.user.id) return error(403, 'Forbidden');

	const solutionDoc = normalizeSolutionDocument(message.solutionDoc);
	if (!solutionDoc) {
		return error(409, 'Detailed solution is not available for this message');
	}

	const xmcd = buildXmcdFromSolutionDocument(solutionDoc, {
		author: locals.user.name ?? locals.user.email ?? 'Coworker User',
		title: message.chat.title
	});
	const filename = makeFilename();

	return new Response(xmcd, {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'no-store'
		}
	});
};

