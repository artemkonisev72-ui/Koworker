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

describe('normalize-v2 direction normalization', () => {
	it('normalizes force direction from textual geometry.direction', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			nodes: [{ id: 'A', x: 0, y: 0 }],
			objects: [
				{
					id: 'force_1',
					type: 'force',
					nodeRefs: ['A'],
					geometry: {
						direction: 'left',
						magnitude: 12
					}
				}
			],
			results: []
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		const force = validation.value.objects.find((object) => object.id === 'force_1');
		expect(force).toBeTruthy();
		expect(force?.geometry.direction).toEqual({ x: -1, y: 0 });
	});

	it('normalizes distributed direction angle aliases', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			nodes: [
				{ id: 'A', x: 0, y: 0 },
				{ id: 'B', x: 3, y: 0 }
			],
			objects: [
				{
					id: 'dist_1',
					type: 'distributed',
					nodeRefs: ['A', 'B'],
					geometry: {
						kind: 'uniform',
						intensity: 5,
						angleDeg: 180
					}
				}
			],
			results: []
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		const distributed = validation.value.objects.find((object) => object.id === 'dist_1');
		expect(distributed).toBeTruthy();
		expect(distributed?.geometry.directionAngle).toBe(180);
	});
});

describe('normalize-v2 epure visuals', () => {
	it('defaults readable epure visuals and warns about missing compressed fiber side for moment epures', () => {
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
				}
			],
			results: [
				{
					id: 'ep_M',
					type: 'epure',
					nodeRefs: ['A', 'B'],
					meta: { baseObjectId: 'bar_1' },
					geometry: {
						kind: 'm',
						baseLine: { startNodeId: 'A', endNodeId: 'B' },
						values: [
							{ s: 0, value: 0 },
							{ s: 0.5, value: 3 },
							{ s: 1, value: 0 }
						]
					}
				}
			]
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		const epure = validation.value.results?.find((result) => result.id === 'ep_M');
		expect(epure?.geometry.kind).toBe('M');
		expect(epure?.geometry.fillHatch).toBe(true);
		expect(epure?.geometry.showSigns).toBe(true);
		expect((validation.warnings ?? []).some((warning) => warning.includes('compressedFiberSide'))).toBe(
			true
		);
	});
});
