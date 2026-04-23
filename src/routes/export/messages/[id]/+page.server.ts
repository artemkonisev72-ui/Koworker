import type { PageServerLoad } from './$types';
import { loadExportMessageForViewer } from '$lib/server/export-message.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	return loadExportMessageForViewer({
		messageId: params.id,
		viewerUserId: locals.user?.id ?? null
	});
};
