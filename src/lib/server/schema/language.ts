export type PromptLanguage = 'ru' | 'en';

const CONTEXT_MARKERS = [
	'[APPROVED_SCHEME_DESCRIPTION]',
	'[ACCEPTED_SCHEMA_REVISIONS]',
	'[SOLVER_MODEL_JSON]',
	'[APPROVED_SCHEMA_JSON]'
];

const USER_TASK_MARKER = '[USER_TASK]';

export function extractLanguageSignalText(text: string): string {
	let earliestMarkerIndex = -1;
	for (const marker of CONTEXT_MARKERS) {
		const markerIndex = text.indexOf(marker);
		if (markerIndex < 0) continue;
		if (earliestMarkerIndex < 0 || markerIndex < earliestMarkerIndex) {
			earliestMarkerIndex = markerIndex;
		}
	}

	if (earliestMarkerIndex >= 0) {
		return text.slice(0, earliestMarkerIndex).trim();
	}

	const userTaskIndex = text.indexOf(USER_TASK_MARKER);
	if (userTaskIndex >= 0) {
		return text.slice(userTaskIndex + USER_TASK_MARKER.length).trim();
	}

	return text;
}

export function detectPromptLanguage(text: string): PromptLanguage {
	const signalText = extractLanguageSignalText(text);
	const cyrillicCount = (signalText.match(/[А-Яа-яЁё]/g) ?? []).length;
	const latinCount = (signalText.match(/[A-Za-z]/g) ?? []).length;

	if (cyrillicCount === 0 && latinCount === 0) return 'en';
	return cyrillicCount >= latinCount * 0.6 ? 'ru' : 'en';
}
