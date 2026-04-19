import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateSchemeDescriptionFromFactsMock } = vi.hoisted(() => ({
	generateSchemeDescriptionFromFactsMock: vi.fn()
}));

vi.mock('$lib/server/ai/gemini.js', () => ({
	generateSchemeDescriptionFromFacts: generateSchemeDescriptionFromFactsMock
}));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { buildAdaptiveSchemeDescription } from './description.ts';

describe('adaptive scheme description helper', () => {
	beforeEach(() => {
		generateSchemeDescriptionFromFactsMock.mockReset();
	});

	it('uses LLM text and removes empty sections', async () => {
		generateSchemeDescriptionFromFactsMock.mockResolvedValueOnce({
			description: `Scheme type:
- Beam

Members and joints:
- AB: A -> B

Supports and constraints:
- Not specified

Loads:
- None`,
			model: 'gemini-3.1-flash-preview',
			tokens: 123
		});

		const result = await buildAdaptiveSchemeDescription({
			schema: {
				version: '2.0',
				nodes: [
					{ id: 'A', x: 0, y: 0 },
					{ id: 'B', x: 4, y: 0 }
				],
				objects: [{ id: 'bar_1', type: 'bar', nodeRefs: ['A', 'B'], geometry: { length: 4, angleDeg: 0 } }],
				results: []
			},
			language: 'en'
		});

		expect(result.source).toBe('llm');
		expect(result.description).toContain('Scheme type:');
		expect(result.description).toContain('Members and joints:');
		expect(result.description).not.toContain('Supports and constraints:');
		expect(result.description).not.toContain('Loads:');
	});

	it('falls back when LLM returns empty output', async () => {
		generateSchemeDescriptionFromFactsMock.mockResolvedValueOnce({
			description: '   ',
			model: 'gemini-3.1-flash-preview',
			tokens: 99
		});

		const result = await buildAdaptiveSchemeDescription({
			schema: {
				version: '2.0',
				nodes: [{ id: 'A', x: 0, y: 0 }],
				objects: [],
				results: []
			},
			language: 'en'
		});

		expect(result.source).toBe('fallback');
		expect(result.description.length).toBeGreaterThan(0);
	});

	it('falls back when LLM throws', async () => {
		generateSchemeDescriptionFromFactsMock.mockRejectedValueOnce(new Error('upstream error'));

		const result = await buildAdaptiveSchemeDescription({
			schema: {
				version: '2.0',
				nodes: [{ id: 'A', x: 0, y: 0 }],
				objects: [],
				results: []
			},
			language: 'en'
		});

		expect(result.source).toBe('fallback');
		expect(result.description.length).toBeGreaterThan(0);
	});
});
