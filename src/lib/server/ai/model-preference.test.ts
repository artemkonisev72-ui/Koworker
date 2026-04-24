import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import {
	DEFAULT_MODEL_PREFERENCE,
	isModelPreference,
	normalizeModelPreference,
	toForcedModel
} from './model-preference.ts';

describe('model preference normalization', () => {
	it('accepts supported values', () => {
		expect(isModelPreference('gemini-3.1-flash-lite-preview')).toBe(true);
		expect(isModelPreference('gemini-3.1-pro-preview')).toBe(true);
		expect(isModelPreference('openrouter:google/gemini-3.1-flash-lite-preview')).toBe(true);
		expect(isModelPreference('openrouter:google/gemini-3.1-pro-preview')).toBe(true);
	});

	it('normalizes unsupported and legacy values to default model', () => {
		expect(normalizeModelPreference('')).toBe(DEFAULT_MODEL_PREFERENCE);
		expect(normalizeModelPreference('auto')).toBe(DEFAULT_MODEL_PREFERENCE);
		expect(normalizeModelPreference('gemini-unknown')).toBe(DEFAULT_MODEL_PREFERENCE);
		expect(normalizeModelPreference('gemini-3.1-pro-preview ')).toBe('gemini-3.1-pro-preview');
		expect(normalizeModelPreference('gemini-3.1-flash-lite-preview')).toBe(
			'gemini-3.1-flash-lite-preview'
		);
	});

	it('converts preference to forced model safely', () => {
		expect(toForcedModel('auto')).toBe(DEFAULT_MODEL_PREFERENCE);
		expect(toForcedModel('gemini-3.1-flash-lite-preview')).toBe(
			'gemini-3.1-flash-lite-preview'
		);
		expect(toForcedModel('openrouter:google/gemini-3.1-pro-preview')).toBe(
			'openrouter:google/gemini-3.1-pro-preview'
		);
		expect(toForcedModel('unsupported')).toBe(DEFAULT_MODEL_PREFERENCE);
	});
});
