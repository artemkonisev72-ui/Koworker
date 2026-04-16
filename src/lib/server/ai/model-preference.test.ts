import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import {
	isModelPreference,
	normalizeModelPreference,
	toForcedModel
} from './model-preference.ts';

describe('model preference normalization', () => {
	it('accepts supported values', () => {
		expect(isModelPreference('auto')).toBe(true);
		expect(isModelPreference('gemini-2.5-flash')).toBe(true);
		expect(isModelPreference('gemini-3.1-pro-preview')).toBe(true);
	});

	it('normalizes unsupported values to auto', () => {
		expect(normalizeModelPreference('')).toBe('auto');
		expect(normalizeModelPreference('gemini-unknown')).toBe('auto');
		expect(normalizeModelPreference('gemini-2.5-flash ')).toBe('gemini-2.5-flash');
	});

	it('converts preference to forced model safely', () => {
		expect(toForcedModel('auto')).toBeNull();
		expect(toForcedModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
		expect(toForcedModel('unsupported')).toBeNull();
	});
});

