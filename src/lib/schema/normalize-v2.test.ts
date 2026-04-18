import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { validateSchemaDataV2 } from './validate-v2.ts';

interface LocalFrameLike {
	x?: { x: number; y: number; z: number };
	y?: { x: number; y: number; z: number };
	z?: { x: number; y: number; z: number };
}

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

	it('canonicalizes simple cantilever epure direction from free end to fixed wall for normalized axis', () => {
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
					id: 'fixed_1',
					type: 'fixed_wall',
					nodeRefs: ['A'],
					geometry: { wallSide: 'left' }
				}
			],
			results: [
				{
					id: 'ep_Q',
					type: 'epure',
					nodeRefs: ['A', 'B'],
					meta: { baseObjectId: 'bar_1' },
					geometry: {
						kind: 'Q',
						compressedFiberSide: '+n',
						baseLine: { startNodeId: 'A', endNodeId: 'B' },
						values: [
							{ s: 0, value: 10 },
							{ s: 0.25, value: 4 },
							{ s: 1, value: 0 }
						]
					}
				}
			]
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		const epure = validation.value.results?.find((result) => result.id === 'ep_Q');
		expect(epure?.geometry.axisOrigin).toBe('free_end');
		expect(epure?.geometry.baseLine).toMatchObject({ startNodeId: 'B', endNodeId: 'A' });
		expect(epure?.nodeRefs).toEqual(['B', 'A']);
		expect(epure?.geometry.values).toEqual([
			{ s: 0, value: 0 },
			{ s: 0.75, value: 4 },
			{ s: 1, value: 10 }
		]);
		expect(epure?.geometry.compressedFiberSide).toBe('+n');
		expect((validation.warnings ?? []).some((warning) => warning.includes('canonicalized to free_end'))).toBe(
			true
		);
	});

	it('canonicalizes simple cantilever epure direction for absolute beam length axis', () => {
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
					id: 'fixed_1',
					type: 'fixed_wall',
					nodeRefs: ['A'],
					geometry: { wallSide: 'left' }
				}
			],
			results: [
				{
					id: 'ep_N',
					type: 'epure',
					nodeRefs: ['A', 'B'],
					meta: { baseObjectId: 'bar_1' },
					geometry: {
						kind: 'N',
						baseLine: { startNodeId: 'A', endNodeId: 'B' },
						values: [
							{ s: 0, value: 10 },
							{ s: 1, value: 6 },
							{ s: 4, value: 0 }
						]
					}
				}
			]
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		const epure = validation.value.results?.find((result) => result.id === 'ep_N');
		expect(epure?.geometry.axisOrigin).toBe('free_end');
		expect(epure?.geometry.values).toEqual([
			{ s: 0, value: 0 },
			{ s: 3, value: 6 },
			{ s: 4, value: 10 }
		]);
	});
});

describe('normalize-v2 frame local frame derivation', () => {
	it('derives stable local frame for planar frame member', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			meta: { structureKind: 'planar_frame' },
			coordinateSystem: {
				modelSpace: 'planar',
				planeNormal: { x: 0, y: 0, z: 1 }
			},
			nodes: [
				{ id: 'A', x: 0, y: 0, z: 0 },
				{ id: 'B', x: 4, y: 0, z: 0 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 4, angleDeg: 0 }
				}
			],
			results: []
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		const bar = validation.value.objects.find((object) => object.id === 'bar_1');
		const localFrame = (bar?.meta?.localFrame as LocalFrameLike | undefined) ?? null;
		expect(localFrame).toBeTruthy();
		expect(localFrame?.x).toMatchObject({ x: 1, y: 0, z: 0 });
		expect(localFrame?.y?.z).toBeCloseTo(0, 6);
		expect(localFrame?.z).toMatchObject({ x: 0, y: 0, z: 1 });
	});

	it('uses secondaryReference for vertical spatial member parallel to referenceUp', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			meta: { structureKind: 'spatial_frame' },
			coordinateSystem: {
				modelSpace: 'spatial',
				referenceUp: { x: 0, y: 0, z: 1 },
				secondaryReference: { x: 1, y: 0, z: 0 }
			},
			nodes: [
				{ id: 'A', x: 0, y: 0, z: 0 },
				{ id: 'B', x: 0, y: 0, z: 5 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 5, angleDeg: 90 }
				}
			],
			results: []
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		const bar = validation.value.objects.find((object) => object.id === 'bar_1');
		const localFrame = (bar?.meta?.localFrame as LocalFrameLike | undefined) ?? null;
		expect(localFrame).toBeTruthy();
		expect(localFrame?.x).toMatchObject({ x: 0, y: 0, z: 1 });
		expect(localFrame?.z?.x).toBeCloseTo(1, 6);
		expect(localFrame?.z?.y).toBeCloseTo(0, 6);
		expect(localFrame?.z?.z).toBeCloseTo(0, 6);
	});

	it('produces deterministic localFrame on repeated normalization', () => {
		const input = {
			version: '2.0',
			meta: { structureKind: 'spatial_frame' },
			coordinateSystem: {
				modelSpace: 'spatial',
				referenceUp: { x: 0, y: 0, z: 1 },
				secondaryReference: { x: 1, y: 0, z: 0 }
			},
			nodes: [
				{ id: 'A', x: 0, y: 0, z: 0 },
				{ id: 'B', x: 3, y: 2, z: 4 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 5.385, angleDeg: 0 }
				}
			],
			results: []
		};

		const first = validateSchemaDataV2(input);
		const second = validateSchemaDataV2(input);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(first.value?.objects[0]?.meta?.localFrame).toEqual(second.value?.objects[0]?.meta?.localFrame);
	});
});

describe('normalize-v2 frame epure canonicalization', () => {
	it('canonicalizes frame epure axis from member_end to member_start', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			meta: { structureKind: 'planar_frame' },
			coordinateSystem: { modelSpace: 'planar', planeNormal: { x: 0, y: 0, z: 1 } },
			nodes: [
				{ id: 'A', x: 0, y: 0, z: 0 },
				{ id: 'B', x: 4, y: 0, z: 0 }
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
					id: 'ep_vy',
					type: 'epure',
					nodeRefs: ['B', 'A'],
					meta: { baseObjectId: 'bar_1' },
					geometry: {
						component: 'Vy',
						axisOrigin: 'member_end',
						baseLine: { startNodeId: 'B', endNodeId: 'A' },
						values: [
							{ s: 0, value: 10 },
							{ s: 1, value: 0 }
						]
					}
				}
			]
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		const epure = validation.value.results?.find((result) => result.id === 'ep_vy');
		expect(epure?.geometry.axisOrigin).toBe('member_start');
		expect(epure?.geometry.component).toBe('Vy');
		expect(epure?.geometry.baseLine).toMatchObject({ startNodeId: 'A', endNodeId: 'B' });
		expect(epure?.nodeRefs).toEqual(['A', 'B']);
		expect(epure?.geometry.values).toEqual([
			{ s: 0, value: 0 },
			{ s: 1, value: 10 }
		]);
	});

	it('maps planar legacy kind Q to component Vy', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			meta: { structureKind: 'planar_frame' },
			coordinateSystem: { modelSpace: 'planar', planeNormal: { x: 0, y: 0, z: 1 } },
			nodes: [
				{ id: 'A', x: 0, y: 0, z: 0 },
				{ id: 'B', x: 4, y: 0, z: 0 }
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
					id: 'ep_q',
					type: 'epure',
					meta: { baseObjectId: 'bar_1' },
					geometry: {
						kind: 'Q',
						baseLine: { startNodeId: 'A', endNodeId: 'B' },
						values: [
							{ s: 0, value: 2 },
							{ s: 1, value: -1 }
						]
					}
				}
			]
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		const epure = validation.value.results?.find((result) => result.id === 'ep_q');
		expect(epure?.geometry.component).toBe('Vy');
		expect(epure?.geometry.axisOrigin).toBe('member_start');
	});

	it('rejects spatial frame legacy kind Q as canonical epure contract', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			meta: { structureKind: 'spatial_frame' },
			coordinateSystem: {
				modelSpace: 'spatial',
				referenceUp: { x: 0, y: 0, z: 1 }
			},
			nodes: [
				{ id: 'A', x: 0, y: 0, z: 0 },
				{ id: 'B', x: 2, y: 1, z: 3 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 3.74, angleDeg: 0 }
				}
			],
			results: [
				{
					id: 'ep_q',
					type: 'epure',
					meta: { baseObjectId: 'bar_1' },
					geometry: {
						kind: 'Q',
						baseLine: { startNodeId: 'A', endNodeId: 'B' },
						values: [
							{ s: 0, value: 2 },
							{ s: 1, value: -1 }
						]
					}
				}
			]
		});

		expect(validation.ok).toBe(false);
		expect(validation.errors.some((error) => error.includes('spatial frame epure cannot use legacy kind'))).toBe(
			true
		);
	});

	it('requires non-zero z coordinates for out-of-plane spatial frame epures', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			meta: { structureKind: 'spatial_frame' },
			coordinateSystem: {
				modelSpace: 'spatial',
				referenceUp: { x: 0, y: 0, z: 1 }
			},
			nodes: [
				{ id: 'A', x: 0, y: 0, z: 0 },
				{ id: 'B', x: 3, y: 0, z: 0 }
			],
			objects: [
				{
					id: 'bar_1',
					type: 'bar',
					nodeRefs: ['A', 'B'],
					geometry: { length: 3, angleDeg: 0 }
				}
			],
			results: [
				{
					id: 'ep_vz',
					type: 'epure',
					meta: { baseObjectId: 'bar_1' },
					geometry: {
						component: 'Vz',
						axisOrigin: 'member_start',
						baseLine: { startNodeId: 'A', endNodeId: 'B' },
						values: [
							{ s: 0, value: 0 },
							{ s: 1, value: 5 }
						]
					}
				}
			]
		});

		expect(validation.ok).toBe(false);
		expect(validation.errors.some((error) => error.includes('requires non-zero node z coordinates'))).toBe(
			true
		);
	});
});

describe('normalize-v2 mechanism object support', () => {
	it('normalizes mechanism aliases and validates kinematic pair objects', () => {
		const validation = validateSchemaDataV2({
			version: '2.0',
			meta: { structureKind: 'planar_mechanism' },
			coordinateSystem: { modelSpace: 'planar' },
			nodes: [
				{ id: 'O', x: 0, y: 0, label: 'O' },
				{ id: 'A', x: 2, y: 0, label: 'A' },
				{ id: 'B', x: 4, y: 0, label: 'B' },
				{ id: 'G1', x: 3.5, y: 0 },
				{ id: 'G2', x: 4.5, y: 0 }
			],
			objects: [
				{ id: 'm1', type: 'bar', nodeRefs: ['O', 'A'], geometry: { length: 2, angleDeg: 0 } },
				{ id: 'm2', type: 'bar', nodeRefs: ['A', 'B'], geometry: { length: 2, angleDeg: 0 } },
				{ id: 'pair1', type: 'pin_joint', nodeRefs: ['A'], geometry: {} },
				{ id: 'pair2', type: 'prismatic_pair', nodeRefs: ['B', 'G1', 'G2'], geometry: {} }
			],
			results: []
		});

		expect(validation.ok).toBe(true);
		expect(validation.value).toBeTruthy();
		if (!validation.value) return;

		const pair1 = validation.value.objects.find((object) => object.id === 'pair1');
		expect(pair1?.type).toBe('revolute_pair');
		const pair2 = validation.value.objects.find((object) => object.id === 'pair2');
		expect(pair2?.type).toBe('prismatic_pair');
	});
});
