import type { GeminiModel } from './gemini.js';

export const MODEL_PREFERENCE_OPTIONS = [
	'auto',
	'gemini-3.1-flash-preview',
	'gemini-3.1-pro-preview',
	'gemini-3-pro-preview',
	'gemini-3-flash-preview',
	'gemini-3.1-flash-lite-preview',
	'gemini-2.5-pro',
	'gemini-2.5-flash',
	'gemini-2.5-flash-lite'
] as const;

export type ModelPreference = (typeof MODEL_PREFERENCE_OPTIONS)[number];

const MODEL_PREFERENCE_SET = new Set<string>(MODEL_PREFERENCE_OPTIONS);

export function isModelPreference(value: unknown): value is ModelPreference {
	return typeof value === 'string' && MODEL_PREFERENCE_SET.has(value.trim());
}

export function normalizeModelPreference(value: unknown): ModelPreference {
	if (typeof value !== 'string') return 'auto';
	const normalized = value.trim();
	return MODEL_PREFERENCE_SET.has(normalized) ? (normalized as ModelPreference) : 'auto';
}

export function toForcedModel(value: unknown): GeminiModel | null {
	const normalized = normalizeModelPreference(value);
	return normalized === 'auto' ? null : (normalized as GeminiModel);
}

