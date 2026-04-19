import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vitest resolves .js to .ts at runtime; svelte-check may report false positive
import { compileSchemeIntent } from './compiler.ts';

describe('scheme compiler', () => {
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
		expect(result.schemaData.objects.find((object) => object.id === 'load_2')?.type).toBe('distributed');
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
	});
});
