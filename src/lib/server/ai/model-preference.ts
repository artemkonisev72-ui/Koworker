export const DEFAULT_MODEL_PREFERENCE = 'gemini-3.1-flash-lite-preview' as const;

export const MODEL_PREFERENCE_OPTIONS = [
	'gemini-3.1-flash-lite-preview',
	'gemini-3.1-pro-preview',
	'openrouter:google/gemini-3.1-flash-lite-preview',
	'openrouter:google/gemini-3.1-pro-preview'
] as const;

export type ModelPreference = (typeof MODEL_PREFERENCE_OPTIONS)[number];

const MODEL_PREFERENCE_SET = new Set<string>(MODEL_PREFERENCE_OPTIONS);

export function isModelPreference(value: unknown): value is ModelPreference {
	return typeof value === 'string' && MODEL_PREFERENCE_SET.has(value.trim());
}

export function normalizeModelPreference(value: unknown): ModelPreference {
	if (typeof value !== 'string') return DEFAULT_MODEL_PREFERENCE;
	const normalized = value.trim();
	if (normalized === 'auto') return DEFAULT_MODEL_PREFERENCE;
	return MODEL_PREFERENCE_SET.has(normalized)
		? (normalized as ModelPreference)
		: DEFAULT_MODEL_PREFERENCE;
}

export function toForcedModel(value: unknown): ModelPreference {
	return normalizeModelPreference(value);
}
