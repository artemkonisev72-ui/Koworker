import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { validateSchemaDataV2 } from './validate-v2.ts';

describe('normalize-v2 epure canonicalization', () => {
	it('moves epure from objects to results and auto-completes required fields', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 4, y: 0 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 4, angleDeg: 0 }
				},
				{
					id: 'ep_1',
					type: 'epure',
					nodeRefs: ['A', 'B'],
					geometry: {
						points: [
							{ x: 0, y: 0 },
							{ x: 1, y: 5 },
							{ x: 2, y: 0 }
						]
					}
				}
			],
			results: []
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		expect(validation.value.objects.some((object) => object.type === 'epure')).toBe(false);

		const epure = validation.value.results?.find((result) => result.type === 'epure');
		expect(epure).toBeTruthy();
		expect(epure?.meta?.baseObjectId).toBe('bar_1');
		expect(typeof epure?.geometry.baseLine).toBe('object');
		expect(Array.isArray(epure?.geometry.values)).toBe(true);
		expect((epure?.geometry.values as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0);
	});

	it('drops incomplete epure from objects instead of failing whole schema', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 3, y: 0 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 3, angleDeg: 0 }
				},
				{
					id: 'ep_bad',
					type: 'epure',
					nodeRefs: ['A', 'B'],
					geometry: {}
				}
			],
			results: []
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		expect(validation.value.objects.some((object) => object.type === 'epure')).toBe(false);
		expect((validation.value.results ?? []).some((result) => result.id === 'ep_bad')).toBe(false);
		expect((validation.warnings ?? []).some((warning) => warning.includes('epure removed'))).toBe(true);
	});
});
