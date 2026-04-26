import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { compileSchemeIntent } from './compiler.ts';

describe('scheme compiler', () => {
	function nodeByIntentKey(result: ReturnType<typeof compileSchemeIntent>, key: string) {
		return result.schemaData.nodes.find((node) => node.meta?.intentKey === key);
	}

	function objectByIntentKey(result: ReturnType<typeof compileSchemeIntent>, key: string) {
		return result.schemaData.objects.find((object) => object.meta?.intentKey === key);
	}

	it('builds deterministic node/object ids for simple beam intent', () => {
		const result = compileSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'high',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B', relation: 'horizontal' }],
			supports: [{ key: 's1', kind: 'hinge_fixed', jointKey: 'A' }],
			loads: [{ key: 'l1', kind: 'force', target: { jointKey: 'B' }, directionHint: 'down', magnitudeHint: 10 }],
			assumptions: [],
			ambiguities: []
		});

		expect(result.schemaData.nodes.map((node) => node.id)).toEqual(['N1', 'N2']);
		expect(result.schemaData.objects.map((object) => object.id)).toEqual(['bar_1', 'support_1', 'load_1']);
		expect(result.compilerFacts.templateUsed).toBe('simple_beam');
	});

	it('creates synthetic attachment nodes for member-relative supports and loads', () => {
		const result = compileSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'beam',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }],
			members: [{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B' }],
			supports: [{ key: 's1', kind: 'hinge_roller', memberKey: 'm1', s: 0.25 }],
			loads: [
				{ key: 'l1', kind: 'moment', target: { memberKey: 'm1', s: 0.8 }, directionHint: 'cw' },
				{
					key: 'l2',
					kind: 'distributed',
					target: { memberKey: 'm1', fromS: 0.1, toS: 0.9 },
					directionHint: 'down',
					distributionKind: 'uniform',
					magnitudeHint: 4
				}
			],
			assumptions: [],
			ambiguities: []
		});

		expect(result.schemaData.nodes.length).toBeGreaterThan(2);
		expect(result.schemaData.objects.find((object) => object.id === 'support_1')?.geometry.attach).toBeTruthy();
		expect(result.schemaData.objects.find((object) => object.id === 'load_1')?.type).toBe('moment');
		const distributed = result.schemaData.objects.find((object) => object.id === 'load_2');
		expect(distributed?.type).toBe('distributed');
		expect(distributed?.geometry.attach).toBeUndefined();
		expect(distributed?.meta?.fromS).toBe(0.1);
		expect(distributed?.meta?.toS).toBe(0.9);
	});

	it('is deterministic for identical input intent', () => {
		const intent = {
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'planar_frame',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [{ key: 'A' }, { key: 'B' }, { key: 'C' }],
			members: [
				{ key: 'm1', kind: 'bar', startJoint: 'A', endJoint: 'B', relation: 'vertical' },
				{ key: 'm2', kind: 'bar', startJoint: 'B', endJoint: 'C', relation: 'horizontal' }
			],
			supports: [{ key: 's1', kind: 'fixed_wall', jointKey: 'A', sideHint: 'left' }],
			loads: [{ key: 'l1', kind: 'force', target: { jointKey: 'C' }, directionHint: 'down', magnitudeHint: 8 }],
			assumptions: [],
			ambiguities: []
		} as const;

		const first = compileSchemeIntent(intent);
		const second = compileSchemeIntent(intent);
		expect(first.schemaData).toEqual(second.schemaData);
	});

	it('compiles planar slider-crank mechanism with explicit kinematic pairs', () => {
		const result = compileSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'planar_mechanism',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [
				{ key: 'O', label: 'O' },
				{ key: 'A', label: 'A' },
				{ key: 'B', label: 'B' }
			],
			members: [
				{ key: 'OA', label: 'OA', kind: 'bar', startJoint: 'O', endJoint: 'A' },
				{ key: 'AB', label: 'AB', kind: 'bar', startJoint: 'A', endJoint: 'B' }
			],
			components: [],
			kinematicPairs: [
				{ key: 'pO', kind: 'revolute_pair', jointKey: 'O', label: 'O-pair' },
				{ key: 'pA', kind: 'revolute_pair', jointKey: 'A', label: 'A-pair' },
				{
					key: 'pB',
					kind: 'prismatic_pair',
					jointKey: 'B',
					guideHint: 'horizontal',
					label: 'B-slider'
				}
			],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		expect(result.schemaData.meta?.structureKind).toBe('planar_mechanism');
		expect(result.schemaData.objects.some((object) => object.type === 'revolute_pair')).toBe(true);
		expect(result.schemaData.objects.some((object) => object.type === 'prismatic_pair')).toBe(true);
		expect(result.schemaData.objects.some((object) => object.label === 'OA')).toBe(true);
	});

	it('places slider-crank slider joint on the horizontal guide through the ground pivot', () => {
		const result = compileSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'planar_mechanism',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [
				{ key: 'O', label: 'O' },
				{ key: 'A', label: 'A' },
				{ key: 'B', label: 'B' }
			],
			members: [
				{
					key: 'OA',
					label: 'OA',
					kind: 'bar',
					startJoint: 'O',
					endJoint: 'A',
					relation: 'inclined',
					lengthHint: 0.35,
					angleHintDeg: 30
				},
				{
					key: 'AB',
					label: 'AB',
					kind: 'bar',
					startJoint: 'A',
					endJoint: 'B',
					relation: 'inclined',
					lengthHint: 0.7
				}
			],
			components: [],
			kinematicPairs: [
				{ key: 'pO', kind: 'revolute_pair', jointKey: 'O', grounded: true, label: 'O-pair' },
				{ key: 'pA', kind: 'revolute_pair', jointKey: 'A', label: 'A-pair' },
				{
					key: 'pB',
					kind: 'prismatic_pair',
					jointKey: 'B',
					guideHint: 'horizontal',
					grounded: true,
					label: 'B-slider'
				}
			],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		const o = nodeByIntentKey(result, 'O');
		const a = nodeByIntentKey(result, 'A');
		const b = nodeByIntentKey(result, 'B');
		expect(o).toBeTruthy();
		expect(a).toBeTruthy();
		expect(b).toBeTruthy();
		expect(a!.y).toBeGreaterThan(o!.y);
		expect(b!.y).toBeCloseTo(o!.y, 6);
		expect(b!.x).toBeGreaterThan(a!.x);

		const oa = objectByIntentKey(result, 'OA');
		const ab = objectByIntentKey(result, 'AB');
		expect(oa?.geometry.length).toBeCloseTo(0.35, 6);
		expect(ab?.geometry.length).toBeCloseTo(0.7, 6);
		expect(ab?.geometry.angleDeg).toBeLessThan(0);

		const slider = objectByIntentKey(result, 'pB');
		const [baseRef, guideStartRef, guideEndRef] = slider?.nodeRefs ?? [];
		const base = result.schemaData.nodes.find((node) => node.id === baseRef);
		const guideStart = result.schemaData.nodes.find((node) => node.id === guideStartRef);
		const guideEnd = result.schemaData.nodes.find((node) => node.id === guideEndRef);
		expect(base?.meta?.intentKey).toBe('B');
		expect(guideStart?.y).toBeCloseTo(o!.y, 6);
		expect(guideEnd?.y).toBeCloseTo(o!.y, 6);
		expect(guideStart?.x).toBeLessThan(b!.x);
		expect(guideEnd?.x).toBeGreaterThan(b!.x);
		expect(guideStart?.visible).toBe(false);
		expect(guideEnd?.visible).toBe(false);
		expect(guideStart?.label).toBeUndefined();
		expect(guideEnd?.label).toBeUndefined();
		expect(guideStart?.meta?.synthetic).toBe(true);
		expect(result.schemaData.meta?.layoutAutoCorrected).toBe(true);
		expect(result.schemaData.meta?.layoutCorrections).toEqual(
			expect.arrayContaining([expect.stringContaining('slider-crank')])
		);
	});

	it('places eccentric slider-crank slider joint on the offset guide', () => {
		const result = compileSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'planar_mechanism',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [
				{ key: 'O', label: 'O' },
				{ key: 'A', label: 'A' },
				{ key: 'B', label: 'B' }
			],
			members: [
				{
					key: 'OA',
					label: 'OA',
					kind: 'bar',
					startJoint: 'O',
					endJoint: 'A',
					relation: 'inclined',
					lengthHint: 0.35,
					angleHintDeg: 30
				},
				{
					key: 'AB',
					label: 'AB',
					kind: 'bar',
					startJoint: 'A',
					endJoint: 'B',
					relation: 'inclined',
					lengthHint: 0.7
				}
			],
			components: [],
			kinematicPairs: [
				{ key: 'pO', kind: 'revolute_pair', jointKey: 'O', grounded: true, label: 'O-pair' },
				{ key: 'pA', kind: 'revolute_pair', jointKey: 'A', label: 'A-pair' },
				{
					key: 'pB',
					kind: 'prismatic_pair',
					jointKey: 'B',
					guideHint: 'horizontal',
					guideOffsetHint: 0.1,
					grounded: true,
					label: 'B-slider'
				}
			],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		const o = nodeByIntentKey(result, 'O');
		const b = nodeByIntentKey(result, 'B');
		expect(o && b).toBeTruthy();
		if (!o || !b) return;
		expect(b.y).toBeGreaterThan(o.y);

		const slider = objectByIntentKey(result, 'pB');
		expect(slider?.geometry.guideOffset).toBe(0.1);
		const guideStart = result.schemaData.nodes.find((node) => node.id === slider?.nodeRefs?.[1]);
		const guideEnd = result.schemaData.nodes.find((node) => node.id === slider?.nodeRefs?.[2]);
		expect(guideStart?.y).toBeCloseTo(b.y, 6);
		expect(guideEnd?.y).toBeCloseTo(b.y, 6);
		expect(result.schemaData.meta?.layoutCorrections).toEqual(
			expect.arrayContaining([expect.stringContaining('slider-crank')])
		);
	});

	it('compiles prismatic pair anchored only by member reference', () => {
		const result = compileSchemeIntent({
			version: 'intent-1.0',
			taskDomain: 'mechanics',
			structureKind: 'planar_mechanism',
			modelSpace: 'planar',
			confidence: 'medium',
			source: { hasImage: false, language: 'ru' },
			joints: [
				{ key: 'O', label: 'O' },
				{ key: 'A', label: 'A' },
				{ key: 'B', label: 'B' }
			],
			members: [
				{ key: 'OA', label: 'OA', kind: 'bar', startJoint: 'O', endJoint: 'A' },
				{ key: 'AB', label: 'AB', kind: 'bar', startJoint: 'A', endJoint: 'B' }
			],
			components: [],
			kinematicPairs: [
				{
					key: 'pB',
					kind: 'prismatic_pair',
					memberKeys: ['AB'],
					guideHint: 'horizontal',
					label: 'B-slider'
				}
			],
			supports: [],
			loads: [],
			assumptions: [],
			ambiguities: []
		});

		const slider = result.schemaData.objects.find((object) => object.type === 'prismatic_pair');
		expect(slider).toBeTruthy();
		expect(slider?.nodeRefs).toHaveLength(3);
		expect(slider?.label).toBe('B-slider');
		const base = result.schemaData.nodes.find((node) => node.id === slider?.nodeRefs?.[0]);
		expect(base?.meta?.intentKey).toBe('B');
	});
});
